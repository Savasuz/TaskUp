# TaskUp

Vazifa bajarib pul ishlash platformasi — web ilova (GitHub Pages) + Android ilova (Capacitor).

## Tuzilma

| Fayl / papka | Nima |
|---|---|
| `index.html` | Foydalanuvchi ilovasi (web + Android WebView asosi) |
| `admin-pro.html` | Admin panel (faqat web) |
| `firestore.rules` | Firestore xavfsizlik qoidalari (Firebase Console'ga joylanadi) |
| `android/` | Capacitor Android loyihasi |
| `.github/workflows/android.yml` | Har push'da APK/AAB avtomatik yig'iladi |

## Android APK olish

1. GitHub'da **Actions** bo'limini oching
2. Oxirgi **"Android APK/AAB yig'ish"** ishga tushirilishini tanlang
3. Pastdagi **Artifacts** dan `TaskUp-debug-apk` ni yuklab oling
4. Ichidagi `app-debug.apk` ni telefonga o'rnating (Noma'lum manbalar ruxsatini yoqish kerak)

## Play Market uchun (AAB)

`TaskUp-release-aab-unsigned` artifacti imzosiz AAB. Play Console'ga yuklashdan oldin
upload-keystore bilan imzolash kerak (Google Play Console hisobi ochilgach sozlanadi).

## Lokal ishlab chiqish

```bash
npm install
mkdir -p www && cp index.html privacy-policy.html terms-of-service.html www/
npx cap sync android
cd android && ./gradlew assembleDebug
```
