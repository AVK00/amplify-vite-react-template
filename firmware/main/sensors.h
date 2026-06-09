/**
 * @file sensors.h
 * @brief DHT22, BH1750 och jordfukt-sensor driver för ESP32
 *        Smart Greenhouse Monitor – IoT & Molntjänster
 */
#pragma once

#include <stdbool.h>
#include "driver/gpio.h"
#include "driver/i2c.h"

/* ── Pin-konfiguration ─────────────────────────────────────── */
#define DHT22_GPIO          GPIO_NUM_4    // DHT22 data-pin
#define SOIL_ADC_CHANNEL    ADC_CHANNEL_6 // GPIO34 (analogt in)
#define I2C_MASTER_SCL      GPIO_NUM_22
#define I2C_MASTER_SDA      GPIO_NUM_21
#define I2C_MASTER_FREQ_HZ  100000
#define BH1750_ADDR         0x23          // ADDR-pin = LOW

/* ── Mätvärden ─────────────────────────────────────────────── */
typedef struct {
    float temperature;    /* °C   – DHT22        */
    float humidity;       /* %RH  – DHT22        */
    float soil_moisture;  /* %    – kapacitiv    */
    float light_lux;      /* lux  – BH1750       */
    float vpd;            /* kPa  – beräknad     */
    bool  valid;
} sensor_data_t;

/* ── API ───────────────────────────────────────────────────── */
esp_err_t sensors_init(void);
esp_err_t sensors_read(sensor_data_t *out);
float     vpd_calculate(float temp_c, float rh_pct);
