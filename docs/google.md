# Connecting Gmail and Google Calendar

The dashboard reads your Gmail and Google Calendar through your **own** OAuth client. Google requires a paid security audit before a public app can read anyone's Gmail. A personal client that only you use skips that audit. Setting one up takes about five minutes and costs nothing.

The access is **read-only**. The dashboard requests exactly two scopes:

- `gmail.readonly`
- `calendar.readonly`

It cannot send, delete or change anything. The token stays in your data folder (`dados/google_token.json`, mode 600) and never leaves your machine.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose inbox you want to read.
2. Create a new project, named for example `job-search-dashboard`.

## 2. Enable the two APIs

Go to **APIs & Services → Library** and enable:

- **Gmail API**
- **Google Calendar API**

## 3. Configure the consent screen

1. Open **Google Auth Platform** (in older consoles: **APIs & Services → OAuth consent screen**) and click **Get started**.
2. Fill in the details:
   - App name: anything you like.
   - Support email: your address.
   - Audience: **External**.
   - Contact email: your address.
3. Under **Audience → Test users**, add your own Gmail address.

## 4. Create the OAuth client

1. Go to **Clients → Create client**.
2. Choose application type **Desktop app**, give it a name, and click **Create**.
3. Click **Download JSON**.

## 5. Give the client to the dashboard

You have two options. Use either one.

**Option A, the downloaded file:** save it as `dados/google_client.json`, next to `tracker.json`.

**Option B, environment variables:** put the values in `.env`. Docker Compose reads them from there.

```
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

Restart the container with `docker compose up -d`.

## 6. Connect

1. Open <http://localhost:8787/#caixa> and click **Ligar conta Google**.
2. Google warns that it **hasn't verified this app**. That is expected, because the app is your own. Click **Continue**.
3. Approve the two read-only permissions.

The first read covers the last 30 days. After that, the dashboard checks again every 30 minutes. You can change the interval with `PAINEL_SYNC_MIN`.

## Tokens that expire after 7 days

While the consent screen is in **Testing**, Google expires refresh tokens after 7 days. When that happens, the dashboard shows an error and you click **Ligar conta Google** again. To avoid reconnecting every week, go to **Audience** and click **Publish app**. The app stays unverified and Google keeps showing the warning screen at sign-in. Google's documentation allows unverified apps to be used for personal projects with a small number of users.

## Disconnecting

Click **Desligar** in the dashboard. This revokes the token at Google and deletes `google_token.json` and the stored emails (`caixa.json`). You can also remove access at any time at <https://myaccount.google.com/permissions>.

## What is read and stored

- **Gmail:** for each message, only the sender, subject, date and the short snippet Gmail generates. Message bodies are not fetched. The search skips promotions, social, sent mail and chats.
- **Calendar:** your primary calendar's events for the next 21 days, with title, date, time, location and link.
- **Storage:** everything goes into `dados/caixa.json` on your machine.
