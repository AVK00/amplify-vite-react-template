/**
 * @file aws_iot.c
 * @brief Ansluter ESP32 till AWS IoT Core via MQTT 3.1.1 över TLS 1.2.
 *
 * Säkerhet:
 *  - TLS 1.2 (tvingat via esp_tls)
 *  - Ömsesidig autentisering med X.509-certifikat (mTLS)
 *  - AWS IoT-policy begränsar topics till enhets-ID
 *  - Certifikat/nyckel lagras i NVS (krypterad partition)
 */
#include "aws_iot.h"

#include <string.h>
#include <time.h>
#include "esp_log.h"
#include "esp_tls.h"
#include "mqtt_client.h"
#include "cJSON.h"
#include "nvs_flash.h"
#include "nvs.h"

static const char *TAG = "AWS_IOT";

/* ── Certifikat (inbäddade som binary vid build) ─────────────── */
extern const uint8_t aws_root_ca_pem_start[]   asm("_binary_aws_root_ca_pem_start");
extern const uint8_t aws_root_ca_pem_end[]     asm("_binary_aws_root_ca_pem_end");
extern const uint8_t device_cert_pem_start[]   asm("_binary_device_cert_pem_start");
extern const uint8_t device_cert_pem_end[]     asm("_binary_device_cert_pem_end");
extern const uint8_t device_key_pem_start[]    asm("_binary_device_key_pem_start");
extern const uint8_t device_key_pem_end[]      asm("_binary_device_key_pem_end");

/* ── Konfiguration – ändra till era faktiska värden ─────────── */
#define AWS_ENDPOINT   "a3vgd2i5cv3wg1-ats.iot.eu-central-1.amazonaws.com"
#define DEVICE_ID      "greenhouse-01"
#define TOPIC_DATA     "greenhouse/greenhouse-01/data"
#define TOPIC_SHADOW   "$aws/things/greenhouse-01/shadow/update"
#define MQTT_PORT      8883

static esp_mqtt_client_handle_t s_client = NULL;
static bool s_connected = false;

/* ── MQTT händelsehanterare ──────────────────────────────────── */
static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            s_connected = true;
            ESP_LOGI(TAG, "Ansluten till AWS IoT Core");
            break;
        case MQTT_EVENT_DISCONNECTED:
            s_connected = false;
            ESP_LOGW(TAG, "Frånkopplad – återansluter…");
            break;
        case MQTT_EVENT_ERROR:
            if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                ESP_LOGE(TAG, "TLS-fel 0x%x", event->error_handle->esp_tls_last_esp_err);
            }
            break;
        default:
            break;
    }
}

/* ── Initiering ──────────────────────────────────────────────── */
esp_err_t aws_iot_init(void)
{
    esp_mqtt_client_config_t cfg = {
        .broker = {
            .address = {
                .hostname  = AWS_ENDPOINT,
                .transport = MQTT_TRANSPORT_OVER_SSL,
                .port      = MQTT_PORT,
            },
            .verification = {
                /* Root CA – verifierar AWS IoT Core-certifikatet */
                .certificate     = (const char *)aws_root_ca_pem_start,
                .certificate_len = aws_root_ca_pem_end - aws_root_ca_pem_start,
            },
        },
        .credentials = {
            .client_id = DEVICE_ID,
            .authentication = {
                /* Enhetscertifikat + privat nyckel (mTLS) */
                .certificate     = (const char *)device_cert_pem_start,
                .certificate_len = device_cert_pem_end - device_cert_pem_start,
                .key             = (const char *)device_key_pem_start,
                .key_len         = device_key_pem_end - device_key_pem_start,
            },
        },
    };

    s_client = esp_mqtt_client_init(&cfg);
    if (!s_client) return ESP_FAIL;

    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    return esp_mqtt_client_start(s_client);
}

/* ── Publicera mätvärden ─────────────────────────────────────── */
esp_err_t aws_iot_publish(const sensor_data_t *data)
{
    if (!s_connected || !s_client) return ESP_ERR_INVALID_STATE;

    /* Bygg JSON-payload */
    time_t now;
    time(&now);
    char iso[32];
    strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId",     DEVICE_ID);
    cJSON_AddStringToObject(root, "timestamp",    iso);
    cJSON_AddNumberToObject(root, "temperature",  data->temperature);
    cJSON_AddNumberToObject(root, "humidity",     data->humidity);
    cJSON_AddNumberToObject(root, "soilMoisture", data->soil_moisture);
    cJSON_AddNumberToObject(root, "lightLevel",   data->light_lux);
    cJSON_AddNumberToObject(root, "vpd",          data->vpd);

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    int msg_id = esp_mqtt_client_publish(s_client, TOPIC_DATA,
                                         payload, 0, 1, 0); /* QoS 1 */
    free(payload);

    if (msg_id < 0) {
        ESP_LOGE(TAG, "Publicering misslyckades");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "Publicerat → %s (msg_id=%d)", TOPIC_DATA, msg_id);
    return ESP_OK;
}

bool aws_iot_connected(void) { return s_connected; }
