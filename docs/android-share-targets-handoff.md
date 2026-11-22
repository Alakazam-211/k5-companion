# Share sheet targets: Android hand-off (for the Android owner)

**What was asked for:** when someone shares from another app on their phone (a photo, a link, text, a file), K2 Companion should appear as a target, and its **agents, people (DMs) and channels** should appear as direct-share options with their pictures, the way messaging apps do. iOS has the same feature in design; this note is so Android gets the same thing.

## iOS (for reference)

- **Share Extension:** K2 shows up as a share target. Its sheet lets you pick an agent, DM or channel (recent ones first), add a note, and send text, links, photos and files.
- **Suggestions:** the app tells iOS about the conversations the person uses (`INSendMessageIntent` donations with a `conversationIdentifier`, the recipient and a picture), for messages they send and messages they receive. The notification extension already does the received side. iOS then lists those conversations in the share sheet's people row, and tapping one opens K2's sheet with it already picked.
- **Open question:** whether the sheet sends the message itself (it then needs the login tokens in shared storage) or hands it to the app to send. The Android choice is the same one; see below.

## The Android equivalent

- **Sharing Shortcuts** (Android 10+, with `androidx.sharetarget` for older versions):
  - Publish dynamic shortcuts, one per recent conversation, through `ShortcutManagerCompat.pushDynamicShortcut`. Each has a stable id, a label, a picture (`IconCompat` from the cached avatar), `setLongLived(true)`, `setPerson(...)`, a category matching the share target (e.g. `com.alakazamlabs.k2.category.SHARE_TARGET`), and `setIsConversation()`.
  - Declare the share target in `res/xml/shortcuts.xml` (`<share-target>` with the mime types: `text/*`, `image/*`, `*/*`, and the category), linked from the launcher activity's `<meta-data android:name="android.app.shortcuts">`.
  - Push or refresh a shortcut whenever the person sends or receives in a conversation, the same moments iOS donates. Remove it when the conversation or server goes away. `reportShortcutUsed(id)` on send.
- **The receiving activity:** an `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent filter on an activity that reads `Intent.EXTRA_SHORTCUT_ID` (the picked conversation, if any), `EXTRA_TEXT` and `EXTRA_STREAM` (copy the content: URIs right away; the grant is short-lived). It shows the same compose sheet: target (pre-picked or chosen), note, attachments, Send.
- **Notifications:** for the conversation shortcuts to rank well and show in the notification shade's conversation section, the message notifications should use `MessagingStyle` with `setShortcutId(<same id>)`. That's the Android side of what the iOS notification extension already does with intents.

## Shared pieces (keep the two apps the same)

- **The conversation id:** one string per target, the same on both platforms. Proposed: `<serverId>|agent|<agent address>`, `<serverId>|dm|<conversationId>`, `<serverId>|channel|<conversationId>`. For a Voice & Chat login, the agent target is its `vc:` conversation address from `/cli/shared`.
- **Sending** (the routes the app already uses):
  - an agent Thread: `POST /cli/thread/post` (the phone's `src/api/client.ts:826`); files first through `POST /cli/fs/upload-binary` into the workspace (`client.ts:696`), then the post names the path;
  - a Voice & Chat login's shared agent: `POST /cli/shared/thread/post {agent, text, clientMsgId}` (no attachments for that role; 2000 characters max, one post per 10 s);
  - a DM or channel: `POST /cli/home-chat/send` (`src/api/homeChat.ts:288`).
- **Pictures:** reuse the app's agent-picture and person-picture caches. Initials on the person's or agent's colour when there's no picture.
- **Logins:** if Android sends from the share activity inside the app process, it already has the tokens, so the iOS keychain question doesn't arise. That's simpler on Android.

## Not in scope

No new daemon routes are needed. If Android wants a "recent conversations" order that matches iOS exactly, use the same rule: last sent or received, newest first, capped at about 8 suggestions.

Questions: open an issue in this repository.
