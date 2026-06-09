/**
 * @file main.c
 * @brief Smart Greenhouse Monitor – huvudprogram
 *
 * Uppgiftsflöde:
 *   1. Initiera NVS, WiFi, sensorer, AWS IoT MQTT-klient
 *   2. Vänta tills WiFi och MQTT är anslutna
 *   3. Läs sensorer var 60:e sekund
 *   4. Publicera JSON-payload till AWS IoT Core (MQTT/TLS)
 *   5. Gå in i light-sleep mellan mätningarna (energibesparing)
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_sntp.h"

#include "sensors.h"
#include "aws_iot.h"

static const char *TAG = "MAIN";

/* ── WiFi-konfiguration (lagras i NVS, inte i kod) ─────────── */
#define WIFI_SSID    CONFIG_WIFI_SSID
#define WIFI_PASS    CONFIG_WIFI_PASSWORD

/* ── Mätintervall ─────────────────────────────────────────────
   60 sekunder i produktion; reducera till 10 s för testning    */
#define MEASURE_INTERVAL_MS  60000

/* ── WiFi event handler ────────────────────────────────────── */
static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "WiFi bortkopplad – återansluter…");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "WiFi OK – IP: " IPSTR, IP2STR(&e->ip_info.ip));
    }
}

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                        wifi_event_handler, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                        wifi_event_handler, NULL, NULL);

    wifi_config_t wconf = {
        .sta = {
            .ssid     = WIFI_SSID,
            .password = WIFI_PASS,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,  /* Kräv WPA2 minimum */
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wconf));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "WiFi startat – ansluter till %s", WIFI_SSID);
}

/* ── SNTP-synkronisering (för korrekt tidsstämpel i JSON) ───── */
static void sntp_init_time(void)
{
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();

    time_t now = 0;
    struct tm ti = {0};
    int retry = 0;
    while (timeinfo.tm_year < (2020 - 1900) && ++retry < 20) {
        ESP_LOGI(TAG, "Väntar på NTP…");
        vTaskDelay(pdMS_TO_TICKS(2000));
        time(&now);
        localtime_r(&now, &ti);
        (void)ti;
    }
}

/* ── Huvuduppgift ─────────────────────────────────────────────── */
static void greenhouse_task(void *pvParam)
{
    /* Vänta tills MQTT är ansluten (max 30 s) */
    int retries = 0;
    while (!aws_iot_connected() && retries++ < 30) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if (!aws_iot_connected()) {
        ESP_LOGE(TAG, "Kunde inte ansluta till AWS IoT Core – startar om");
        esp_restart();
    }

    sensor_data_t sd;
    while (true) {
        if (sensors_read(&sd) == ESP_OK) {
            aws_iot_publish(&sd);
        }
        vTaskDelay(pdMS_TO_TICKS(MEASURE_INTERVAL_MS));
    }
}

/* ── app_main ─────────────────────────────────────────────────── */
void app_main(void)
{
    /* NVS – används av WiFi-stacken och för att lagra certs */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    ESP_LOGI(TAG, "=== Smart Greenhouse Monitor v1.0 ===");

    wifi_init();
    sensors_init();

    /* Invänta IP-adress innan MQTT ansluts */
    vTaskDelay(pdMS_TO_TICKS(3000));

    sntp_init_time();
    aws_iot_init();

    xTaskCreate(greenhouse_task, "greenhouse_task",
                8192, NULL, 5, NULL);
}
