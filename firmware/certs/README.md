# Certifikat för ESP32 – AWS IoT Core

Placera följande PEM-filer i denna mapp innan build:

| Fil | Beskrivning |
|-----|-------------|
| `aws_root_ca.pem` | Amazon Root CA 1 (laddas ned från AWS) |
| `device_cert.pem` | Enhetscertifikat (skapas i IoT Core) |
| `device_key.pem`  | Privat RSA-nyckel (genereras vid cert-skapande) |

**Filer läggs ALDRIG till i Git** – se `.gitignore`.

## Hämta Root CA

```
curl -o aws_root_ca.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem
```

## Skapa enhetscertifikat (AWS CLI)

```bash
aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile device_cert.pem \
  --public-key-outfile device_pub.pem \
  --private-key-outfile device_key.pem
```

Notera certifikatets ARN för IoT-policy-bindningen.
