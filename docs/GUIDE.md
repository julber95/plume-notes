# Setting up Plume

This guide is for someone who does not program. There are three steps, done
once, in this order:

1. put Plume online (free, with GitHub);
2. allow Plume to access your OneDrive (free, with Microsoft);
3. install Plume on the tablet.

Allow about half an hour. Until step 2 is done Plume already works, but notes
stay on the device only.

---

## Step 1 — Put Plume online

Plume is a web application: it must be reachable at an `https://…` address to
be installed on the tablet. GitHub hosts this kind of site for free.

1. Create an account on <https://github.com> if you do not have one.
2. Create a repository: **New repository** button, name `plume`, visibility
   **Public**, nothing else ticked. (Free hosting requires a public
   repository. The code contains no password and none of your notes.)
3. In the repository, open **Settings → Pages** and, under **Build and
   deployment**, set **Source** to **GitHub Actions**.
4. Create an access token, which GitHub requires instead of your password to
   send code: <https://github.com/settings/tokens> → **Generate new token
   (classic)**, tick **repo** and **workflow**, then copy the token (it starts
   with `ghp_`). Never share this token.
5. Send the code of this folder to the repository. From this folder, in a
   terminal:

   ```
   git remote add origin https://github.com/MYACCOUNT/plume.git
   git push -u origin main
   ```

   Git asks for a username (your GitHub username) and a password (paste the
   token).
6. Open the **Actions** tab: a "Deploy" job is running. When it turns green
   (2 to 3 minutes), Plume is online at:

   **`https://MYACCOUNT.github.io/plume/`**

   Write this address down exactly, including the trailing slash: it is needed
   in step 2. If your repository has another name, that name replaces `plume`
   in the address.

From then on, every code change sent to GitHub updates the site by itself, and
the tablet picks up the new version the next time it is opened.

---

## Step 2 — Allow access to OneDrive

For an application to read and write in a OneDrive, Microsoft requires it to
be "registered". Registration is free and yields a **client ID**: a string of
letters and digits, which is not a secret, to paste into Plume.

### 2a. Get access to the Microsoft portal

A personal Microsoft account alone is no longer enough to register an
application: it needs an Azure account (Microsoft's online service for
developers). Without one, the portal shows errors such as "the selected user
account does not exist in tenant 'Microsoft Services'". Two options:

- **Free Azure account**: <https://azure.microsoft.com/free>, button **Try
  Azure for free**. Sign in with your personal Microsoft account and fill in
  the form (phone number, then a bank card used to verify your identity).
  Registering an application costs nothing.
- **Azure for Students**: <https://azure.microsoft.com/free/students>. No bank
  card, but it requires a school e-mail address, and the sign-up does not
  always work with a personal account.

The Azure account and the OneDrive do not have to be the same account: Azure
is only used to declare the application. Your notes go to the OneDrive you
sign in to inside Plume.

Avoid private browsing windows for these steps: they block the cookies the
Microsoft portal needs.

### 2b. Register the application

The labels below are those of the English interface; if the portal is shown
in another language they are translated but located in the same place.

1. Open <https://portal.azure.com> and sign in with the Azure account.
2. In the search bar at the top, type **App registrations** and open the
   result, then click **New registration**.
3. **Name**: `Plume`.
4. **Supported account types**: choose **Personal accounts only**. This
   matters: with another choice, signing in from Plume is refused.
5. Click **Register**.
6. On the page that appears, copy the **Application (client) ID** value
   (of the form `12345678-abcd-…`).
7. In the application's menu: **Manage → Authentication**, then
   **Add Redirect URI**.
8. Choose the **Single-page application** tile, then enter Plume's address
   from step 1, exactly, including the trailing slash:
   `https://MYACCOUNT.github.io/plume/`
9. Click **Configure**.

Nothing else needs to be set: no secret, no permission to add.

### 2c. Give the ID to Plume

Open the file `src/config.ts` and paste the ID between the quotes on the line:

```ts
const CLIENT_ID = ''
```

which gives for example `const CLIENT_ID = '12345678-abcd-…'`. Then send the
change to GitHub (`git push`). Two to three minutes later the site is up to
date.

### 2d. Sign in

Open Plume, tap the **Sign-in required** indicator at the top right, then
**Sign in to OneDrive**. Microsoft shows a sign-in page, then asks you to
agree that Plume has "full access to your files": this is the narrowest
permission Microsoft offers that allows creating the `Plume` folder at the
root of OneDrive. Plume only touches that folder.

The indicator switches to **Up to date** and a `Plume` folder appears in your
OneDrive.

Good to know: for a web application, Microsoft limits a session to 24 hours.
Plume signs in again by itself on opening when possible; otherwise the
indicator shows "Sign-in required" and one tap is enough. In all cases, what
you write is saved on the tablet and goes to OneDrive as soon as you are
signed in again.

### If signing in fails

- **"redirect URI … does not match"** (code AADSTS50011): the address entered
  at point 8 is not exactly Plume's. Check the `https`, the account name, the
  repository name and the trailing slash.
- **"unauthorized_client"** or **"not enabled for consumers"**: the account
  type chosen at point 4 is not "Personal accounts only". The simplest fix is
  to delete the registration and do it again.

---

## Step 3 — Install Plume on the tablet

1. On the tablet, open Plume's address in **Chrome**.
2. Chrome's **⋮** menu → **Add to Home screen** → **Install**.
3. Start Plume from its icon: it opens full screen, like an application, and
   also works without a network.
4. Sign in to OneDrive (step 2d) if not done yet.

On a computer, just open the same address in a browser and sign in: the
notebooks appear and stay editable. And in any case, each notebook is an
ordinary PDF in the `Plume` folder of OneDrive.

After an update, close Plume completely and open it twice: the first opening
downloads the new version, the second one uses it.

---

## Checks to do on the tablet

These points could not be verified without the tablet. Ten minutes is enough.

| What to check | How | Expected result |
| --- | --- | --- |
| Palm rejection | Write several lines with your hand resting on the screen | No stray strokes, the page does not move |
| Pressure | Write pressing more or less hard | The stroke gets thicker with pressure |
| Writing smoothness | Write fast, then on an already full page | The stroke follows the tip without annoying lag, letters are round |
| Scroll and zoom | Scroll with one finger, pinch to zoom | Smooth movement, sharp image when it stops |
| Stylus button | Hold the side button while drawing | The stylus erases while the button is held |
| Offline | Airplane mode, write, close then reopen Plume | Everything is there; the indicator shows "Offline" |
| Network back | Turn airplane mode off | The indicator switches to "Up to date" within a minute |
| PDF in OneDrive | Open OneDrive on the computer | The notebook's PDF is in `Plume/…`, up to date |
| Folders | Create, rename, move a folder in Plume | The same change appears in OneDrive |

If one of these does not give the expected result, note which one and under
what conditions: that is what will need adjusting.

---

## Good to know

- **Every stroke is saved on the device the moment it is drawn.** OneDrive
  sync comes on top: when a notebook is closed, when you leave the
  application, and every 5 minutes while writing (adjustable in the settings,
  icon at the top right of the library).
- **When you leave the application**, the upload starts but Android may
  interrupt it if it is long. It then resumes the next time Plume is opened.
  To be sure the PDF has gone, wait for "Up to date" before leaving.
- **Do not clear Chrome's browsing data** for Plume's site while the
  indicator is not "Up to date": that is where notes not yet sent are kept.
- **A PDF modified with another program** (annotations added in a PDF reader,
  for example): Plume will reopen its own strokes, not those additions.
- **One device at a time.** If the same notebook is modified in two places
  before being synced, Plume does not choose for you: it keeps both versions
  (one is renamed "… (conflict date time)") and shows a notice in the
  library.
- **Deletion**: an item deleted in Plume goes to the OneDrive recycle bin,
  where it stays recoverable for 30 days.
