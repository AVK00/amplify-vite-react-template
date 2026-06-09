/**
 * @file sensors.c
 * @brief Simulerade sensorvärden för demo utan fysisk hårdvara.
 *        Värden varierar realistiskt kring typiska växthus-nivåer.
 */
#include "sensors.h"

#include <math.h>
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "SENSORS";

/* Returnerar ett slumpmässigt float-värde i intervallet [base-range, base+range] */
static float rand_range(float base, float range)
{
    /* esp_random() ger 0–UINT32_MAX; normalisera till 0.0–1.0 */
    float r = (float)(esp_random()) / (float)(UINT32_MAX);
    return base + (r * 2.0f - 1.0f) * range;
}

/* ══════════════════════════════════════════════════════════════
   VPD-beräkning  (Ångrycktsdifferens)
   vpd = svp * (1 - rh/100)   där svp = 0.6108 * exp(17.27*T/(T+237.3))
   ══════════════════════════════════════════════════════════════ */
float vpd_calculate(float temp_c, float rh_pct)
{
    float svp = 0.6108f * expf(17.27f * temp_c / (temp_c + 237.3f));
    return svp * (1.0f - rh_pct / 100.0f);
}

/* ══════════════════════════════════════════════════════════════
   Initiering – inget hårdvarusetup behövs i simulerat läge
   ══════════════════════════════════════════════════════════════ */
esp_err_t sensors_init(void)
{
    ESP_LOGI(TAG, "Simulerade sensorer initierade (demo-läge)");
    return ESP_OK;
}

/* ══════════════════════════════════════════════════════════════
   Generera realistiska växthus-värden med liten slumpmässig variation
   Basvärden:
     Temperatur  : 23.5 °C  ± 1.5
     Luftfuktighet: 68 %    ± 6
     Jordfukt    : 58 %     ± 8
     Ljus        : 340 lux  ± 60
   ══════════════════════════════════════════════════════════════ */
esp_err_t sensors_read(sensor_data_t *out)
{
    memset(out, 0, sizeof(*out));

    out->temperature  = rand_range(23.5f, 1.5f);
    out->humidity     = rand_range(68.0f, 6.0f);
    out->soil_moisture = rand_range(58.0f, 8.0f);
    out->light_lux    = rand_range(340.0f, 60.0f);
    out->vpd          = vpd_calculate(out->temperature, out->humidity);
    out->valid        = true;

    ESP_LOGI(TAG, "T=%.1f°C  RH=%.1f%%  Soil=%.1f%%  Lux=%.0f  VPD=%.2f kPa",
             out->temperature, out->humidity,
             out->soil_moisture, out->light_lux, out->vpd);

    return ESP_OK;
}
