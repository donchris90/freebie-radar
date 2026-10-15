# Setting up on Windows (PowerShell)

All commands start from `C:\freebie-radar`.

## 1. Install and database
```powershell
npm install                       # once, at the repo root (also after pulling changes)
cd apps\api
copy .env.example .env            # then edit .env
npx prisma migrate dev --name init   # creates/updates every table; commit the new prisma\migrations folder
npm run start:dev
```
If the API log says `The column ... does not exist` (Prisma P2021/P2022) the database is behind the code: run the migrate command again and restart. The app shows "The service is being updated" until you do.

## 2. Email (Gmail)
Use a Google **App Password** (needs 2-step verification), not your normal password.
```
MAIL_DRIVER=smtp
SMTP_URL=smtps://you%40gmail.com:APPPASSWORD@smtp.gmail.com:465
MAIL_FROM="Freebie Radar <you@gmail.com>"
```
Check it without starting the API: `npm run check:mail` (in `apps\api`). Restart the API after editing `.env`.

## 3. Photos (Cloudflare R2)
```
STORAGE_DRIVER=s3
S3_BUCKET=...  S3_REGION=auto  S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://<public bucket address>
```
The `r2.dev` address is for testing only. For production use a custom domain on a separate bucket.

## 4. Mobile
```powershell
cd apps\mobile
npx expo start
```
Set `EXPO_PUBLIC_API_URL` to an address your phone can reach (your PC's LAN IP, not localhost). Ads are off unless `EXPO_PUBLIC_ADS_ENABLED=true`, and never run in Expo Go.

## 5. New features, in short
- **Reservations**: "I'll take it" holds a free item for 2 h; the giver confirms; pickup stays open 24 h. Lapsed holds and giver cancels never count against anyone. A giver can report a no-show only 30 min after confirming. Reliability is shown only to the giver, and only after 3 clear outcomes.
- **Spotted**: free curb finds with a photo and pin, 24 h life, 10/day, not messageable. "It's gone" by the poster closes it at once; two different members close it too.
- **Share pages**: `GET /s/<listing id>` shows a safe preview (approximate area only; noindex).
- **Referral codes**: every member has one; admins create ambassador codes (Admin → Growth). Counts are evidence, not proof.
- **Organisations**: Admin → Growth → approve an account's email; it can then import up to 100 rows per CSV.
