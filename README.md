# The Treehouse: setup guide

A private chat for you and your friends. Rooms, live messages, an access code, and no accounts.
Your friends only need the link and the code.

You will put the files on GitHub (free), then have Render (free) run them. It takes about 15 minutes.
Screens change now and then, so a button may be named slightly differently. The steps still work.

## What's in this folder

| File | What it does |
| --- | --- |
| `server.js` | The chat server. Checks the access code and passes messages around. |
| `index.html`, `style.css`, `app.js` | The chat page your friends see. |
| `package.json` | Tells the host what to install and how to start. |
| `README.md` | This guide. You don't need to upload this one. |

## Step 1: Put the files on GitHub

1. Go to **github.com** and sign up (free). Confirm your email.
2. Click the **+** at the top right, then **New repository**.
3. Name it `treehouse-chat`. Choose **Private** (so only you can see the files). Click **Create repository**.
4. On the new empty page, click the link that says **uploading an existing file**.
5. Drag in these five files: `server.js`, `index.html`, `style.css`, `app.js`, `package.json`.
   Put them straight in, not inside another folder.
6. Scroll down and click **Commit changes**.

## Step 2: Run it on Render

1. Go to **render.com** and click **Get Started**. Sign up with **GitHub** (the easiest way).
2. Click **New +** at the top, then **Web Service**.
3. Choose to connect your GitHub account. When it asks which repositories Render can see, pick `treehouse-chat`.
4. Select `treehouse-chat` from the list.
5. Fill in the form:
   - **Name:** anything you like, for example `our-treehouse`. This becomes part of your link.
   - **Runtime / Language:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
6. Find **Environment Variables** and click **Add Environment Variable**:
   - **Key:** `ACCESS_CODE`
   - **Value:** the code you want your friends to type, for example `maple-42`
   Pick something your friends can type easily but others can't guess. It is not case sensitive.
7. Click **Create Web Service** (or **Deploy**).
8. Wait a few minutes. When the page says **Live**, your link is at the top, something like
   `https://our-treehouse.onrender.com`.

## Step 3: Invite your friends

Send them the link and the code. They open the link, type the code and a name, and they're in.

You can try it first: open the link yourself, enter the code, and send a message.

## Things to know

- **The first visit can be slow.** On the free plan the app goes to sleep after about 15 minutes with nobody on it.
  The next person to open the link waits up to a minute while it wakes up. The page says so and keeps trying by itself.
- **Old messages can disappear.** The free plan wipes saved files when the app restarts or you upload new files.
  Recent messages survive normal sleeping, but don't count on the history lasting.
- **Changing the code.** In Render, open your service, then **Environment**, edit `ACCESS_CODE`, and save.
  Render restarts the app. Anyone who comes back after that needs the new code.
- **Wrong guesses are slowed down.** After 6 wrong codes from one address, that address is blocked for 10 minutes.
- **Your friends can delete only their own messages,** and rename themselves at any time.
- **Privacy.** The code keeps strangers out, but the chat is not end to end encrypted. Don't share passwords or
  anything private in it.
- **Updating the app later.** In GitHub, open the file, click the pencil, change it, and commit. Render redeploys on its own.

## Running it on your own computer (optional)

You need Node.js 18 or newer from nodejs.org. Open a terminal in this folder and run:

```
npm install
ACCESS_CODE=maple-42 npm start
```

On Windows PowerShell:

```
npm install
$env:ACCESS_CODE="maple-42"; npm start
```

Then open http://localhost:3000. Only people on your own network can reach it that way.
