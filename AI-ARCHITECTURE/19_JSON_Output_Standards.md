# 19 - JSON ve Çıktı Format Standartları (JSON Output Standards)

## 📐 Standart API Yanıt Yapısı

Platform genelinde API yanıtları tutarlı JSON formatında döner:

### 1. Başarılı Yanıt Standardı
```json
{
  "datasetId": 12,
  "datasetFilename": "satislar.csv",
  "profile": { "rowCount": 1500, "columnCount": 6 },
  "widgets": []
}
```

### 2. Standart Hata Yanıtı (`Error Payload`)
```json
{
  "error": {
    "code": "INVALID_DATASET_FORMAT",
    "message": "CSV dosyası başlık ve en az bir veri satırı içermelidir."
  }
}
```
