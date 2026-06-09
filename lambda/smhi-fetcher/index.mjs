/**
 * SMHI Fetcher Lambda
 *
 * Körs på schema (EventBridge Scheduler, var 30:e minut).
 * Hämtar aktuellt väder från SMHI Open Data API för Stockholm
 * och sparar det i SMHISnapshot-tabellen via AppSync.
 *
 * SMHI API: https://opendata.smhi.se/apidocs/metobs/
 * Station 98210 = Stockholm-Observatoriekullen
 */

import https from "node:https";

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT;
const GRAPHQL_API_KEY  = process.env.GRAPHQL_API_KEY;

const STATION     = "98210";
const LOCATION    = "Stockholm";

/* SMHI parameter-ID:n */
const PARAM_TEMP    = 1;   // Lufttemperatur (°C)
const PARAM_HUMID   = 6;   // Relativ luftfuktighet (%)
const PARAM_WIND    = 4;   // Vindhastighet (m/s)
const PARAM_PRECIP  = 5;   // Nederbördsintensitet (mm/h)

async function smhiFetch(param) {
  const url = `https://opendata-download-metobs.smhi.se/api/version/latest/parameter/${param}/station/${STATION}/period/latest-hour/data.json`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end",  () => {
        try {
          const json = JSON.parse(data);
          const values = json.value;
          if (!values?.length) return resolve(null);
          resolve(parseFloat(values[values.length - 1].value));
        } catch { resolve(null); }
      });
    }).on("error", reject);
  });
}

const CREATE_SMHI = /* GraphQL */ `
  mutation CreateSMHISnapshot($input: CreateSMHISnapshotInput!) {
    createSMHISnapshot(input: $input) { id timestamp }
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
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end",  () => resolve(JSON.parse(d)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export const handler = async () => {
  const [temp, humid, wind, precip] = await Promise.all([
    smhiFetch(PARAM_TEMP),
    smhiFetch(PARAM_HUMID),
    smhiFetch(PARAM_WIND),
    smhiFetch(PARAM_PRECIP),
  ]);

  const snapshot = {
    timestamp:       new Date().toISOString(),
    location:        LOCATION,
    outdoorTemp:     temp    ?? 0,
    outdoorHumidity: humid   ?? null,
    windSpeed:       wind    ?? null,
    precipitation:   precip  ?? null,
  };

  console.log("SMHI snapshot:", snapshot);

  const res = await gqlRequest(CREATE_SMHI, { input: snapshot });
  if (res.errors) console.error("GraphQL-fel:", res.errors);
  return { statusCode: 200 };
};
