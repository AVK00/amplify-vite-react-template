#!/usr/bin/env bash
# =============================================================================
# aws_iot_setup.sh
# Skapar AWS IoT Core-resurser för Smart Greenhouse Monitor
#
# Krav: AWS CLI v2 konfigurerat med lämpliga rättigheter
# Kör: bash iot/aws_iot_setup.sh
# =============================================================================
set -euo pipefail

THING_NAME="greenhouse-01"
POLICY_NAME="GreenhousePolicy"
REGION="eu-central-1"
CERT_DIR="firmware/certs"

echo "▶  Skapar IoT Thing: $THING_NAME"
aws iot create-thing \
  --thing-name "$THING_NAME" \
  --region "$REGION"

echo "▶  Skapar och aktiverar X.509-certifikat"
CERT_OUTPUT=$(aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile "$CERT_DIR/device_cert.pem" \
  --public-key-outfile      "$CERT_DIR/device_pub.pem" \
  --private-key-outfile     "$CERT_DIR/device_key.pem" \
  --region "$REGION")

CERT_ARN=$(echo "$CERT_OUTPUT" | grep -o '"certificateArn": "[^"]*"' | cut -d'"' -f4)
CERT_ID=$(echo "$CERT_OUTPUT"  | grep -o '"certificateId": "[^"]*"'  | cut -d'"' -f4)
echo "   Certifikat ARN: $CERT_ARN"

echo "▶  Hämtar Amazon Root CA 1"
curl -sSo "$CERT_DIR/aws_root_ca.pem" \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem

echo "▶  Skapar IoT-policy: $POLICY_NAME"
aws iot create-policy \
  --policy-name "$POLICY_NAME" \
  --policy-document file://iot/iot_policy.json \
  --region "$REGION"

echo "▶  Kopplar policy till certifikat"
aws iot attach-policy \
  --policy-name "$POLICY_NAME" \
  --target "$CERT_ARN" \
  --region "$REGION"

echo "▶  Kopplar certifikat till Thing"
aws iot attach-thing-principal \
  --thing-name "$THING_NAME" \
  --principal  "$CERT_ARN" \
  --region "$REGION"

echo "▶  Skapar IoT Rule → Lambda"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:iot-processor"

aws iot create-topic-rule \
  --rule-name "GreenhouseDataRule" \
  --topic-rule-payload "{
    \"sql\": \"SELECT * FROM 'greenhouse/+/data'\",
    \"ruleDisabled\": false,
    \"actions\": [{
      \"lambda\": { \"functionArn\": \"$LAMBDA_ARN\" }
    }],
    \"errorAction\": {
      \"cloudwatchLogs\": {
        \"logGroupName\": \"/aws/iot/greenhouse-errors\",
        \"roleArn\": \"arn:aws:iam::${ACCOUNT_ID}:role/IoTCoreCloudWatchRole\"
      }
    }
  }" \
  --region "$REGION"

echo "▶  Ger IoT Core tillåtelse att anropa Lambda"
aws lambda add-permission \
  --function-name iot-processor \
  --statement-id  iot-invoke \
  --action        lambda:InvokeFunction \
  --principal     iot.amazonaws.com \
  --source-arn    "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/GreenhouseDataRule" \
  --region "$REGION"

ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS \
  --region "$REGION" --query endpointAddress --output text)

echo ""
echo "✅  Konfiguration klar!"
echo "   AWS IoT Endpoint: $ENDPOINT"
echo "   Uppdatera AWS_ENDPOINT i firmware/main/aws_iot.c"
echo "   Certifikat sparade i $CERT_DIR/"
