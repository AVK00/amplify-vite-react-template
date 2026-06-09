idf_component_register(
    SRCS
        "main.c"
        "sensors.c"
        "aws_iot.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash
        esp_wifi
        mqtt
        esp_http_client
        esp_tls
        esp_system
        esp_timer
        json
)
