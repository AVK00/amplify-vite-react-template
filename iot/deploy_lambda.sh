#!/usr/bin/env bash
# =============================================================================
# deploy_lambda.sh
# Driftsätter iot-processor och smhi-fetcher till AWS Lambda
#
# Kör EFTER att du har kört:  npx ampx sandbox  (eller pipeline-deploy)
# så att amplify_outputs.json har de riktiga värdena.
#
# Krav: AWS CLI v2, Node.js 22, zip
# =============================================================================
set -euo pipefail

REGION="eu-central-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
S3_BUCKET="greenhouse-raw-data-${ACCOUNT_ID}"

# ── Läs AppSync-värden direkt från amplify_outputs.json ─────────────────────
GRAPHQL_ENDPOINT=$(node -e "const o=require('./amplify_outputs.json'); console.log(o.data.url)")
GRAPHQL_API_KEY=$(node  -e "const o=require('./amplify_outputs.json'); console.log(o.data.api_key)")

echo "AppSync endpoint : $GRAPHQL_ENDPOINT"
echo "S3 bucket        : $S3_BUCKET"
echo "Region           : $REGION"
echo "Account          : $ACCOUNT_ID"

# ── Skapa S3-bucket för rådata ───────────────────────────────────────────────
if ! aws s3api head-bucket --bucket "$S3_BUCKET" --region "$REGION" &>/dev/null; then
  echo "▶  Skapar S3-bucket: $S3_BUCKET"
  aws s3api create-bucket \
    --bucket "$S3_BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  # Blockera all publik åtkomst
  aws s3api put-public-access-block \
    --bucket "$S3_BUCKET" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  # Livscykelregel – ta bort data äldre än 90 dagar (kostnadsbesparing)
  aws s3api put-bucket-lifecycle-configuration \
    --bucket "$S3_BUCKET" \
    --lifecycle-configuration '{
      "Rules":[{"ID":"expire-old-data","Status":"Enabled",
        "Filter":{"Prefix":""},"Expiration":{"Days":90}}]}'
  echo "   S3-bucket skapad med publik-blockering och 90-dagarsregel"
fi

# ── Lägg till S3-rättigheter på Lambda-rollen ────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "GreenhouseS3Access" \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{
      \"Effect\":\"Allow\",
      \"Action\":[\"s3:PutObject\"],
      \"Resource\":\"arn:aws:s3:::${S3_BUCKET}/greenhouse-*\"
    }]
  }" \
  --region "$REGION"

# ── Skapa IAM-roll för Lambda (om den inte finns) ────────────────────────────
ROLE_NAME="GreenhouseLambdaRole"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

if ! aws iam get-role --role-name "$ROLE_NAME" --region "$REGION" &>/dev/null; then
  echo "▶  Skapar IAM-roll: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},
      "Action":"sts:AssumeRole"}]}' \
    --region "$REGION"
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
    --region "$REGION"
  sleep 10   # Vänta tills rollen är aktiv
fi

# ── iot-processor ────────────────────────────────────────────────────────────
echo ""
echo "▶  Paketerar lambda/iot-processor …"
(cd lambda/iot-processor && zip -q -r ../..//tmp/iot-processor.zip index.mjs)

if aws lambda get-function --function-name iot-processor --region "$REGION" &>/dev/null; then
  echo "▶  Uppdaterar iot-processor (update-function-code) …"
  aws lambda update-function-code \
    --function-name iot-processor \
    --zip-file fileb:///tmp/iot-processor.zip \
    --region "$REGION"
else
  echo "▶  Skapar iot-processor …"
  aws lambda create-function \
    --function-name  iot-processor \
    --runtime        nodejs22.x \
    --handler        index.handler \
    --zip-file       fileb:///tmp/iot-processor.zip \
    --role           "$ROLE_ARN" \
    --timeout        30 \
    --environment    "Variables={
        GRAPHQL_ENDPOINT=$GRAPHQL_ENDPOINT,
        GRAPHQL_API_KEY=$GRAPHQL_API_KEY,
        S3_BUCKET_NAME=$S3_BUCKET,
        DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL:-}}" \
    --region         "$REGION"
fi

# ── smhi-fetcher ─────────────────────────────────────────────────────────────
echo ""
echo "▶  Paketerar lambda/smhi-fetcher …"
(cd lambda/smhi-fetcher && zip -q -r /tmp/smhi-fetcher.zip index.mjs)

if aws lambda get-function --function-name smhi-fetcher --region "$REGION" &>/dev/null; then
  echo "▶  Uppdaterar smhi-fetcher …"
  aws lambda update-function-code \
    --function-name smhi-fetcher \
    --zip-file fileb:///tmp/smhi-fetcher.zip \
    --region "$REGION"
else
  echo "▶  Skapar smhi-fetcher …"
  aws lambda create-function \
    --function-name  smhi-fetcher \
    --runtime        nodejs22.x \
    --handler        index.handler \
    --zip-file       fileb:///tmp/smhi-fetcher.zip \
    --role           "$ROLE_ARN" \
    --timeout        30 \
    --environment    "Variables={
        GRAPHQL_ENDPOINT=$GRAPHQL_ENDPOINT,
        GRAPHQL_API_KEY=$GRAPHQL_API_KEY}" \
    --region         "$REGION"
fi

# ── EventBridge Scheduler för smhi-fetcher ───────────────────────────────────
SCHEDULER_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/GreenhouseLambdaRole"
SMHI_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:smhi-fetcher"

if ! aws scheduler get-schedule --name smhi-schedule --region "$REGION" &>/dev/null; then
  echo "▶  Skapar EventBridge-schema för smhi-fetcher (var 30:e minut) …"
  aws scheduler create-schedule \
    --name smhi-schedule \
    --schedule-expression "rate(30 minutes)" \
    --target "{\"Arn\":\"$SMHI_ARN\",\"RoleArn\":\"$SCHEDULER_ROLE\",\"Input\":\"{}\"}" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --region "$REGION" || echo "   (Scheduler kräver extra IAM-rättigheter – konfigurera manuellt om det misslyckas)"
fi

echo ""
echo "✅  Lambda-driftsättning klar!"
echo ""
echo "Nästa steg:"
echo "  1. bash iot/aws_iot_setup.sh        # Skapa IoT Thing + certifikat"
echo "  2. cd firmware && idf.py build flash monitor"
echo "  3. npx ampx sandbox                 # (om du inte deployat Amplify än)"
