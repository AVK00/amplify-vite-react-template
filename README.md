# 🌿 Smart Greenhouse Monitor – IoT & Molntjänster

> **Kurs:** IoT och Molntjänster | **Student:** [Ditt namn] | **Lärare:** Johan

Realtidsövervakning av ett växthus med ESP32, AWS IoT Core och en React-dashboard
byggd med AWS Amplify. Systemet mäter temperatur, luftfuktighet, jordfukt och ljusnivå,
lagrar datat i DynamoDB och jämför det med utomhusväder från SMHI.

---

## 📋 Kravställning

| # | Krav | Källa |
|---|------|-------|
| K1 | Övervaka inomhusklimatet i ett växthus i realtid | Funktionellt |
| K2 | Larma via Discord om temperaturen överstiger 35 °C | Funktionellt |
| K3 | Spara alla mätvärden för historisk analys | Funktionellt |
| K4 | Jämföra inomhusklimatet med utomhusväder (SMHI) | Funktionellt |
| K5 | Säker kommunikation – kryptering och autentisering | Säkerhet |
| K6 | Dashboard tillgänglig via webbläsare med inloggning | Funktionellt |

---

## 1. Systemskiss

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SENSORNOD (ESP32)                           │
│                                                                     │
│  [DHT22]──┐                                                         │
│  [BH1750]─┼──► [ESP32 Devkit C]──WiFi──► MQTT/TLS 1.2 ──────────► │
│  [Soil]───┘       (ESP-IDF v5.5)          Port 8883                 │
└─────────────────────────────────────────────────────────────────────┘
                                                  │
                                    X.509 mTLS-certifikat
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         AWS MOLNTJÄNSTER                            │
│                                                                     │
│  ┌──────────────┐   IoT Rule    ┌──────────────────┐               │
│  │ AWS IoT Core │──────────────►│ Lambda           │               │
│  │  (MQTT Broker│               │ iot-processor    │               │
│  │  Port 8883)  │               │ • Validering     │               │
│  └──────────────┘               │ • Tröskelkontroll│               │
│                                 │ • Discord-larm   │               │
│                                 └────────┬─────────┘               │
│                                          │ AppSync (GraphQL)        │
│                                          ▼                          │
│                                 ┌──────────────────┐               │
│  ┌──────────────┐               │ AWS AppSync      │               │
│  │ EventBridge  │──30 min──────►│ (GraphQL API)    │               │
│  │ Scheduler    │   Lambda      │                  │               │
│  │              │ smhi-fetcher  └────────┬─────────┘               │
│  └──────────────┘                        │                          │
│                                          ▼                          │
│                                 ┌──────────────────┐               │
│                                 │  Amazon DynamoDB  │               │
│                                 │  • SensorReading  │               │
│                                 │  • Alert          │               │
│                                 │  • SMHISnapshot   │               │
│                                 └──────────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
                │
                │ HTTPS / GraphQL (Cognito JWT)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      VISUALISERING (Amplify)                        │
│                                                                     │
│  React + Vite + Recharts                                            │
│  • Realtidsprenumeration (AppSync WebSocket)                        │
│  • Linjediagram: temp, fukt, jordfukt, ljus                         │
│  • SMHI-jämförelse                                                  │
│  • Larmhantering                                                    │
│  • VPD-indikator                                                    │
│                                                                     │
│  Inloggning via Amazon Cognito (e-post + lösenord)                  │
└─────────────────────────────────────────────────────────────────────┘

Externt:
  SMHI Open Data API ──► Lambda smhi-fetcher ──► DynamoDB
  Discord Webhook    ◄── Lambda iot-processor (larm)
```

---

## 2. Komponenter – hårdvara

| Komponent | Funktion | Gränssnitt |
|-----------|----------|------------|
| ESP32 DevKit C | Mikrokontroller / gateway | WiFi 802.11 b/g/n |
| DHT22 | Temperatur (−40…+80 °C ±0.5) och luftfuktighet (0–100 % ±2–5) | 1-wire GPIO |
| BH1750 | Ljusnivå 1–65 535 lux (±20 %) | I²C (0x23) |
| Kapacitiv jordfuktsensor | Jordfukt 0–100 % | ADC (GPIO34) |
| MicroUSB / 5V adapter | Strömförsörjning | — |

### Kopplingsschema

```
ESP32          DHT22         BH1750        Jordfukt
 3.3V ──────── VCC           VCC           VCC
 GND  ──────── GND           GND           GND
 GPIO4 ─────── DATA (4.7kΩ pull-up till 3.3V)
 GPIO21 ──────────────────── SDA
 GPIO22 ──────────────────── SCL
 GPIO34 ───────────────────────────────── AOUT
```

---

## 3. Säkerhetslösning

### 3.1 Transportlagersäkerhet (TLS)

All kommunikation mellan ESP32 och AWS IoT Core sker via **MQTT over TLS 1.2**
(port 8883). TLS-versioner äldre än 1.2 är inaktiverade i `sdkconfig.defaults`.

### 3.2 Ömsesidig autentisering (mTLS / X.509)

```
ESP32  ──── skickar ──►  device_cert.pem   (signerat av AWS IoT CA)
       ◄─── verifierar ─  AWS IoT Core-certifikat (Amazon Root CA 1)
```

Varje enhet har ett unikt X.509-certifikat. Certifikaten kan återkallas
direkt i AWS IoT Core-konsolen utan firmware-uppdatering.

### 3.3 Minsta behörighet (Least Privilege) – IoT-policy

`iot/iot_policy.json` begränsar enhetens rättigheter till:

- **Publish** BARA på `greenhouse/${iot:ClientId}/data` (ej andras topics)
- **Connect** BARA med klient-ID som matchar `greenhouse-*`
- **Subscribe** BARA på egna shadow-topics

### 3.4 Applikationssäkerhet (Dashboard)

| Mekanism | Implementering |
|----------|---------------|
| Autentisering | Amazon Cognito User Pool (e-post + lösenord) |
| Auktorisering | JWT-token i varje AppSync-anrop |
| Dataägarskap | Amplify `allow.owner()` – användare ser bara egna poster |
| API-nyckel | Kortlivad, används BARA av betrodda Lambda-funktioner |
| HTTPS | Amplify Hosting serverar alltid via HTTPS (TLS 1.2+) |

### 3.5 Hårdvarusäkerhet (ESP32)

- **NVS-kryptering** skyddar lagrade certifikat mot fysisk åtkomst
- **Secure Boot** (aktiverbart i `sdkconfig.defaults`) verifierar firmware-signaturen
- **Flash-kryptering** (aktiverbart) krypterar det lagrade programmet
- WiFi konfigurerat att kräva **WPA2 minimum**

### 3.6 Certifikatshantering

```
firmware/certs/   ← ALDRIG committat till Git (.gitignore)
  aws_root_ca.pem
  device_cert.pem
  device_key.pem
```

---

## 4. Datalagring

Systemet använder **två lagringsytor** enligt kursens upplägg (DynamoDB + S3):

### DynamoDB (via AppSync)
Tre tabeller skapas av Amplify:

| Tabell | Syfte |
|--------|-------|
| `SensorReading` | Strukturerade mätvärden (60 s intervall) – för dashboard |
| `Alert` | Genererade larm + kvitteringsstatus |
| `SMHISnapshot` | Utomhusväder var 30:e minut |

### S3 (rådata-arkiv)
Bucket: `greenhouse-raw-data-{accountId}`  
Varje MQTT-meddelande sparas också som rå JSON:

```
s3://greenhouse-raw-data-123456/
  greenhouse-01/
    2026/06/05/
      2026-06-05T12-00-00Z.json   ← hela ursprungspayloaden
```

- Publik åtkomst blockerad
- Automatisk radering efter 90 dagar (kostnadsbesparing)
- Används för historisk analys / export

### Varför DynamoDB *och* S3?
| | DynamoDB | S3 |
|---|---|---|
| **Styrka** | Strukturerade queries, realtid via AppSync | Billig bulklagring, rå JSON, long-term |
| **Kostnad** | On-demand, lämplig för aktiv data | ~$0.023/GB/mån |
| **Användning** | Dashboard-visualisering | Historisk analys, backup |

---

## 5. Visualisering

Dashboarden (React + Recharts + AWS Amplify) visar:

- **4 mätvärde-kort** – aktuella sensorvärden med varningsindikator
- **Linjediagram** – senaste 24 timmarnas historik per mätvärde
- **SMHI-panel** – utomhusväder + differens mot inomhustemperatur
- **Larmlista** – aktiva larm med kvitteringsknapp
- **VPD-indikator** – ångrycktsdifferens med zonfärgkodning

Data uppdateras i **realtid** via AppSync WebSocket-prenumerationer
(`observeQuery`) utan att sidan behöver laddas om.

---

## 6. Externa integrationer

### SMHI Open Data API
- **URL:** `https://opendata-download-metobs.smhi.se/api/version/latest/...`
- **Station:** 98210 (Stockholm-Observatoriekullen)
- **Schema:** EventBridge Scheduler kör `lambda/smhi-fetcher` var 30:e minut
- **Data:** Temperatur, luftfuktighet, vindhastighet, nederbördsintensitet

### Discord Webhook (larmnotiser)
- `lambda/iot-processor` skickar ett embed-meddelande till en Discord-kanal
  när ett tröskelvärde överstigs
- Webhook-URL lagras som krypterad miljövariabel i Lambda (ej i kod)

---

## 7. Skalbarhet (VG-kriterium)

| Aspekt | Nuvarande lösning | Vid skalning |
|--------|-------------------|--------------|
| Enheter | 1 ESP32 | Hundratals – IoT Fleet Provisioning |
| Datainmatning | 1 msg/min | Tusentals/s – IoT Core skalas automatiskt |
| Lagring | DynamoDB on-demand | Amazon Timestream + S3 Glacier för cold storage |
| Bearbetning | Lambda per meddelande | Kinesis Data Streams + batch-Lambda |
| Visualisering | Amplify Hosting | CloudFront CDN (ingår) |
| Certifikat | Manuellt | AWS IoT Fleet Provisioning + just-in-time registration |

---

## 8. Projektstruktur

```
├── amplify/              # AWS Amplify Gen 2 backend
│   ├── auth/resource.ts  # Cognito-konfiguration
│   ├── data/resource.ts  # DynamoDB-scheman (AppSync)
│   └── backend.ts
├── firmware/             # ESP32 firmware (ESP-IDF v5.5)
│   ├── main/
│   │   ├── main.c        # Huvudprogram + WiFi
│   │   ├── sensors.c/h   # DHT22, BH1750, jordfukt
│   │   └── aws_iot.c/h   # MQTT/TLS mot AWS IoT Core
│   ├── certs/            # X.509-certifikat (INTE i Git)
│   └── sdkconfig.defaults
├── lambda/
│   ├── iot-processor/    # Triggas av IoT Rule – sparar data + larm
│   └── smhi-fetcher/     # Hämtar SMHI-data var 30:e minut
├── iot/
│   ├── aws_iot_setup.sh  # Skapar IoT-resurser i AWS
│   └── iot_policy.json   # Minsta-behörighet-policy
└── src/                  # React dashboard
    ├── App.tsx
    └── App.css
```

---

## 9. Uppstart och driftsättning

### 9.1 AWS Amplify backend

```bash
npm install
npx ampx sandbox          # Lokal dev-miljö
```

### 9.2 AWS IoT Core (kör en gång)

```bash
bash iot/aws_iot_setup.sh
```

### 9.3 Lambda-funktioner

```bash
cd lambda/iot-processor
zip function.zip index.mjs
aws lambda create-function \
  --function-name iot-processor \
  --runtime nodejs22.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::ACCOUNT:role/LambdaIoTRole \
  --environment "Variables={GRAPHQL_ENDPOINT=...,GRAPHQL_API_KEY=...,DISCORD_WEBHOOK_URL=...}"
```

### 9.4 ESP32 firmware

```bash
cd firmware
idf.py set-target esp32
idf.py menuconfig    # Konfigurera WiFi SSID/lösenord
# Lägg certifikat i firmware/certs/
idf.py build flash monitor
```

### 9.5 EventBridge Scheduler (SMHI)

```bash
aws scheduler create-schedule \
  --name smhi-fetcher-schedule \
  --schedule-expression "rate(30 minutes)" \
  --target '{"Arn":"arn:aws:lambda:eu-north-1:ACCOUNT:function:smhi-fetcher","RoleArn":"..."}' \
  --flexible-time-window '{"Mode":"OFF"}'
```

---

## 10. Betygskriterier – uppfyllelse

### Godkänd (G)

| Kriterium | Hur det uppfylls |
|-----------|-----------------|
| Designa enkel IoT-arkitektur med säkerhet | Systemskiss (avsnitt 1) + säkerhetslösning (avsnitt 3) |
| Kommunikation sensor ↔ gateway | ESP32 → DHT22/BH1750/Soil via GPIO/I²C/ADC (`firmware/`) |
| Molntjänster för visualisering | AWS Amplify + AppSync + React-dashboard (`src/`) |

### Väl godkänd (VG)

| Kriterium | Hur det uppfylls |
|-----------|-----------------|
| Skalbarhet för IoT-tjänster | Avsnitt 7 – skalningstabell + motivering |
| Skilja mellan lagrings- och visualiseringssätt | DynamoDB vs Timestream (avsnitt 4), dashboard vs Discord (avsnitt 5–6) |
| IoT-lösning med hög säkerhet utifrån kravställning | mTLS, least-privilege-policy, Cognito, NVS-kryptering (avsnitt 3) |

---

## Licens

MIT-0 – se [LICENSE](LICENSE).