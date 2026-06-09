/**
 * IoT Rule Lambda – iot-processor
 *
 * Triggras av AWS IoT Core Topic Rule när ett meddelande publiceras
 * till  greenhouse/+/data
 *
 * Åtgärder:
 *   1. Validerar och sanitiserar inkommande payload
 *   2. Sparar rå JSON till S3 (long-term arkiv)
 *   3. Sparar SensorReading till DynamoDB via AppSync (Amplify)
 *   4. Kontrollerar tröskelvärden → skapar Alert-poster
 *   5. Skickar Discord-notis om kritiskt värde
 */

import https from "node:https";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT;   // Amplify AppSync URL
const GRAPHQL_API_KEY  = process.env.GRAPHQL_API_KEY;    // API-nyckel (rotera regelbundet)
const DISCORD_WEBHOOK  = process.env.DISCORD_WEBHOOK_URL; // Discord webhook-URL
const S3_BUCKET        = process.env.S3_BUCKET_NAME;     // t.ex. "greenhouse-raw-data-123456"

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-central-1" });

/* ── Tröskelvärden ──────────────────────────────────────────── */
const THRESHOLDS = {
  HIGH_TEMP:  { field: "temperature",  op: ">",  value: 35.0,  label: "🌡 Hög temperatur" },
  LOW_SOIL:   { field: "soilMoisture", op: "<",  value: 25.0,  label: "🪴 Låg jordfukt"   },
  HIGH_HUMID: { field: "humidity",     op: ">",  value: 90.0,  label: "💧 Hög luftfuktighet" },
  LOW_LIGHT:  { field: "lightLevel",   op: "<",  value: 20.0,  label: "☀ Låg ljusnivå" },
};

/* ── S3 – spara rå payload som JSON ────────────────────────── */
async function saveToS3(payload, deviceId, timestamp) {
  if (!S3_BUCKET) return;
  // Nyckelformat: greenhouse-01/2026/06/05/2026-06-05T12:00:00Z.json
  const date = new Date(timestamp);
  const key = [
    deviceId,
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    `${timestamp.replace(/[:.]/g, "-")}.json`,
  ].join("/");

  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        JSON.stringify(payload),
    ContentType: "application/json",
  }));
  console.log(`S3: s3://${S3_BUCKET}/${key}`);
}

/* ── AppSync GraphQL mutation ───────────────────────────────── */
const CREATE_READING = /* GraphQL */ `
  mutation CreateSensorReading($input: CreateSensorReadingInput!) {
    createSensorReading(input: $input) { id deviceId timestamp }
  }`;

const CREATE_ALERT = /* GraphQL */ `
  mutation CreateAlert($input: CreateAlertInput!) {
    createAlert(input: $input) { id alertType }
  }`;

async function gqlRequest(query, variables) {
  const body = JSON.stringify({ query, variables });
  const url  = new URL(GRAPHQL_ENDPOINT);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname,
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-api-key":      GRAPHQL_API_KEY,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end",  () => resolve(JSON.parse(data)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── Discord-notis ──────────────────────────────────────────── */
async function sendDiscordAlert(label, deviceId, value, threshold) {
  if (!DISCORD_WEBHOOK) return;
  const payload = JSON.stringify({
    username: "Greenhouse Monitor",
    embeds: [{
      title:       `⚠️ Larm: ${label}`,
      description: `**Enhet:** ${deviceId}\n**Värde:** ${value.toFixed(1)}\n**Tröskel:** ${threshold}`,
      color:       0xe74c3c,
      timestamp:   new Date().toISOString(),
    }],
  });
  const url = new URL(DISCORD_WEBHOOK);
  await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(payload) } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/* ── Validering ────────────────────────────────────────────── */
function validatePayload(msg) {
  const required = ["deviceId","timestamp","temperature","humidity","soilMoisture","lightLevel"];
  for (const f of required) {
    if (msg[f] === undefined || msg[f] === null) throw new Error(`Saknat fält: ${f}`);
  }
  if (typeof msg.temperature  !== "number" || msg.temperature  < -40 || msg.temperature  > 80)
    throw new Error("Ogiltigt temperaturvärde");
  if (typeof msg.humidity     !== "number" || msg.humidity     <   0 || msg.humidity     > 100)
    throw new Error("Ogiltigt fuktighetsvärde");
  if (typeof msg.soilMoisture !== "number" || msg.soilMoisture <   0 || msg.soilMoisture > 100)
    throw new Error("Ogiltigt jordfuktvärde");
  if (typeof msg.lightLevel   !== "number" || msg.lightLevel   <   0 || msg.lightLevel   > 200000)
    throw new Error("Ogiltigt ljusvärde");
  /* Sanitisera deviceId – tillåt bara alfanumeriska och bindestreck */
  if (!/^[a-z0-9-]{3,32}$/.test(msg.deviceId))
    throw new Error("Ogiltigt deviceId-format");
}

/* ── Handler ───────────────────────────────────────────────── */
export const handler = async (event) => {
  console.log("Mottaget:", JSON.stringify(event));

  // AWS IoT Core skickar ett enda event-objekt (ej array)
  const msg = typeof event === "string" ? JSON.parse(event) : event;

  try {
    validatePayload(msg);
  } catch (err) {
    console.error("Valideringsfel:", err.message);
    return { statusCode: 400, body: err.message };
  }

  const reading = {
    deviceId:     msg.deviceId,
    timestamp:    msg.timestamp,
    temperature:  msg.temperature,
    humidity:     msg.humidity,
    soilMoisture: msg.soilMoisture,
    lightLevel:   msg.lightLevel,
    vpd:          msg.vpd ?? null,
  };

  /* 1. Spara rå payload i S3 (långtidsarkiv) */
  await saveToS3(msg, msg.deviceId, msg.timestamp);

  /* 2. Spara i DynamoDB (via AppSync) */
  const saveRes = await gqlRequest(CREATE_READING, { input: reading });
  if (saveRes.errors) {
    console.error("GraphQL-fel:", saveRes.errors);
    throw new Error("Kunde inte spara mätvärde");
  }

  /* 3. Kontrollera tröskelvärden */
  for (const [alertType, thr] of Object.entries(THRESHOLDS)) {
    const val = msg[thr.field];
    const triggered = thr.op === ">" ? val > thr.value : val < thr.value;
    if (!triggered) continue;

    const alert = {
      deviceId:  msg.deviceId,
      timestamp: msg.timestamp,
      alertType,
      value:     val,
      threshold: thr.value,
      resolved:  false,
    };
    await gqlRequest(CREATE_ALERT, { input: alert });
    await sendDiscordAlert(thr.label, msg.deviceId, val, thr.value);
    console.log(`Larm skapat: ${alertType} (${val})`);
  }

  return { statusCode: 200, body: "OK" };
};
