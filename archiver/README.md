# WhatsApp archive: WAHA + archiver

One **stack per WhatsApp account**. Each stack is two containers from the same `docker-compose.yml`:

- **WAHA**: a linked device on the account. It receives live messages and can pull history, names and photos.
- **waha-archiver**: imports the account's phone backups (iOS or Android), pulls from WAHA, keeps everything in
  one SQLite archive, and serves the **reader** (a web page for browsing, searching and viewing media).

Your iOS stack and your Android stack are separate deployments. They use the same compose file and the same
images, but each has its own `.env`, folders, containers and secrets. Nothing is shared between them.

Images (built in this fork by GitHub Actions):

- `ghcr.io/deepakgaur84/waha:gows-latest` is the unmodified upstream WAHA source. Built by hand: Actions -> *Build WAHA image* -> Run workflow.
- `ghcr.io/deepakgaur84/waha-archiver:latest` is built automatically when `archiver/` changes on branch `core`.

---

## 1. Set up a stack (the same for iOS and Android)

Do these once per account.

1. **Folders on the NAS** (File Station). Choose three that belong only to this account:
   - the **backup folder** (read-only to the archiver), holds the phone backups;
   - the **archive folder**, where the archiver writes its database, media and reports;
   - the **WAHA folder**, where WAHA keeps its session (`sessions/` and `media/` are created inside).
2. **Create the stack** in Dockhand: new stack, paste the contents of `docker-compose.yml`.
3. **Fill in the environment** (use `.env.example` as the list). Every value marked *per stack* must be different
   from your other stacks:

   | Value | Meaning |
   |---|---|
   | `WAHA_CONTAINER`, `ARCHIVER_CONTAINER` | unique container names (they are also the proxy targets) |
   | `BACKUP_DIR`, `ARCHIVE_DIR`, `WAHA_DIR` | the three folders from step 1 |
   | `WAHA_API_KEY`, `WAHA_DASHBOARD_PASSWORD`, `WHATSAPP_SWAGGER_PASSWORD` | new secrets |
   | `WAHA_WEBHOOK_HMAC_SECRET` | a long random string; signs the WAHA -> archiver webhook |
   | `ANDROID_KEY` | Android accounts only (section 3) |

   Do not leave `BACKUP_DIR`, `ARCHIVE_DIR` or `WAHA_DIR` out. The defaults in the compose file point at the
   first stack's folders, and a second stack that used them would write into the first stack's archive.
4. **Proxy (Zoraxy)**: add rules for a new hostname, with authentication switched on:
   - `/` goes to `<ARCHIVER_CONTAINER>:3000` (the reader);
   - `/api` goes to `<WAHA_CONTAINER>:3000` (WAHA), the same way you set it up for the first stack.
5. **Deploy.** Dockhand pulls the images and starts both containers.
6. **Check the archiver log.** The first line should say `[archiver] build <name> listening on 3000`.

## 2. iOS account

**Backups.** The archiver reads decrypted iOS backup snapshots. Each snapshot is a folder inside `BACKUP_DIR`
that contains `Manifest.db` and the usual two-character subfolders. Snapshot folders carry a 14-digit timestamp in
their name (for example `..._20260720151456_WhatsApp`).

1. Put the snapshot folder(s) inside `BACKUP_DIR`. Nothing else is needed in `.env`.
2. Restart the archiver (or use *Run backup import* in the reader's Preferences).
3. Log: `Found N ios backup(s) ...`, then `<folder>: done in Ns. X read, Y new, media A/B found.`

Backups are cumulative, so by default only the newest snapshot is read (*Backup import mode* in Preferences:
`latest` or `all`). A snapshot that finished importing is skipped on later starts.

**WAHA.** Link the account (section 4). Messages that exist in both the backup and WAHA join into one row, because
they share WhatsApp's own message id. `PROBE_STANZA_IDS` can hold a few message ids; the import log then says
whether each was found, which proves the ids match.

## 3. Android account

**Backups.** The archiver reads Android *end-to-end encrypted* backups (`.crypt15`) and decrypts them itself.
`.crypt14` backups need a key file that only a rooted phone can provide, so they are not supported.

**On the phone, once:**

1. WhatsApp -> Settings -> Chats -> Chat backup -> **End-to-end encrypted backup** -> Turn on.
2. Choose *Use 64-digit encryption key instead*, copy the 64 characters somewhere safe, then finish.
   Lose the key and the backups cannot be opened.
3. Make a new backup (*Back up* in Chat backup). The menu wording can differ slightly between versions.

**Get the files to the NAS.** Connect the phone by USB (File transfer mode), then in File Explorer open:

`Internal storage` -> `Android` -> `media` -> `com.whatsapp` -> `WhatsApp`

Copy its `Databases` and `Media` folders (and `Backups`, if you like) into a new folder inside `BACKUP_DIR`, named
for the date, for example `BACKUP_DIR/261016/`. The result:

```
BACKUP_DIR/
  261016/
    Databases/   msgstore.db.crypt15  (and other files, ignored)
    Media/       WhatsApp Images, WhatsApp Video, ...
```

The Google Drive copy of the backup cannot be downloaded, so use the phone's own files.

**In `.env`:** set `ANDROID_KEY` to the 64 characters (hex digits only, no spaces), then redeploy. The key is read
from the environment, is never logged, and is never written to the archive.

**Log:** `Found N android backup(s) ...`, then `<folder>: done in Ns. X read, Y new, media A/B found.` If something
is wrong the log says why in plain words: no key set, wrong key, or a crypt14 file.

**What comes across:** text messages, media that is on disk, captions, group names, edits (shown as "edited"),
deletions (shown as "Deleted by the sender"), reactions and starred messages. WhatsApp's own notices (the "+0"
chat), status updates, bots and system rows are skipped.

**What the backup does not contain:** contact names (Android reads them from the phone's Contacts app, not from the
backup) and profile photos. Groups show their names; one-to-one chats show phone numbers. Linking WAHA (next
section) is how names and photos arrive. Media that the phone never downloaded is not in the backup either.

A decrypted `msgstore.db` placed in `Databases` is used in preference to the encrypted file. You do not need one.

## 4. Link the account to WAHA (both account types)

1. Open the WAHA dashboard for this stack, signing in with `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`.
2. Start the session named `default`. A QR code appears.
3. On the phone: WhatsApp -> Settings -> **Linked devices** -> Link a device, then scan the QR code.
4. Wait for the session to reach **WORKING**.
5. The archiver's next sync pulls history, names and photos. It retries every 2 minutes while WAHA starts or the
   session is not ready. After that it syncs on the interval set in Preferences.

WAHA stays linked to the account until you unlink it (WhatsApp -> Linked devices on the phone).

## 5. The reader and its Preferences

Open the stack's reader hostname. Behaviour settings live in the reader (the menu icon next to *Chats*), not in `.env`:

- **Reader mode:** show iOS backups, Android backups, or all. WAHA-only (live) messages show in every mode.
- **Backup import mode and excluded backup folders:** which snapshots are read.
- **Hide and do not archive chats ending with:** for example `@newsletter`, `@broadcast`, or the Status chat.
- **Sync interval, profile photos, media retry:** WAHA sync timing, photo fetching, and *Retry failed media*.

## 6. Checks and troubleshooting

| What you see | What it means / what to do |
|---|---|
| Log shows an old `build` line | The old image is running. Wait for the green *Build archiver* run in Actions, then redeploy with the pull option on. A plain restart reuses the old image. |
| `No backups found under /backup` | Wrong `BACKUP_DIR`, an empty folder, or no `Manifest.db` (iOS) / `Databases` file (Android) inside the backup folder. The import is skipped; everything else keeps running. |
| `is encrypted: set ANDROID_KEY` | The Android backup is `.crypt15` and the key is not set in `.env`. |
| `wrong key for this backup` | The key does not match that backup. Backups made before the key was regenerated need the old key. |
| `is a crypt14 backup` | Turn on end-to-end encrypted backup in WhatsApp and make a new backup. |
| `WAHA 401` in the log | `WAHA_API_KEY` differs between the archiver and WAHA, or this stack has no WAHA container to talk to (set `WAHA_ENABLED=false` for a backup-only stack). |
| WAHA sync keeps retrying | The session is not WORKING yet (not linked, or still starting). |
| Chat names show as numbers | Normal for Android backups until WAHA is linked and has synced. |

## 7. Updating

- **Archiver changes:** commit to `archiver/` on branch `core`. The build runs by itself. When it is green, redeploy
  the stack with the pull option on.
- **WAHA / upstream changes:** sync the fork with upstream, then run *Build WAHA image* by hand, then redeploy.
- Redeploying does not touch your archive: it lives in `ARCHIVE_DIR`.

## 8. Security

- The reader has no login of its own. Its protection is Zoraxy authentication on the proxy rule; keep it on.
- `/webhook` is internal-only and checked with `WAHA_WEBHOOK_HMAC_SECRET`; always set that value.
- Keep `ANDROID_KEY` out of anything shared. Docker and Dockhand can show environment values to anyone with access
  to them. Regenerate the key in WhatsApp if it has been exposed.
- Backups are mounted read-only. The archiver copies or decrypts a database into a temporary file and removes it
  afterwards.
