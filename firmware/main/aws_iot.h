/**
 * @file aws_iot.h
 * @brief MQTT-klient mot AWS IoT Core med ömsesidig TLS (mTLS)
 */
#pragma once

#include "sensors.h"
#include "esp_err.h"

/* Certifikat och nycklar lagras i NVS och/eller inbäddas som
 * binary blobs via CMake (se firmware/certs/README.md).        */

esp_err_t aws_iot_init(void);
esp_err_t aws_iot_publish(const sensor_data_t *data);
bool      aws_iot_connected(void);
