const $ = id => document.getElementById(id);
let chats = [];
let nearbyCameraStream = null;
let nearbyScanFrame = 0;

function initVoiceChatButton() {
  const button = document.getElementById("voiceChatBtn");
  const stopButton = document.getElementById("voiceChatStopBtn");
  if (!button || !stopButton) return;

  let micStream = null;
  let recorder = null;
  let audioChunks = [];
  let audioContext = null;
  let analyser = null;
  let volumeFrame = 0;
  let recordingChatIndex = null;
  let isStarting = false;
  let isStopping = false;
  let isSaving = false;
  let pendingVoiceBlob = null;
  let pendingVoiceChatIndex = null;
  let voicePreviewUrl = null;

  function updateVoiceButton() {
    const isRecording = recorder?.state === "recording";
    const isPaused = recorder?.state === "paused";
    const state = isSaving ? "saving" : isStopping ? "stopping" : isStarting ? "starting" : isRecording ? "recording" : isPaused ? "paused" : "idle";
    button.dataset.state = state;
    stopButton.hidden = state !== "recording" && state !== "paused";
    stopButton.disabled = state === "saving";
    stopButton.textContent = "Stop";
    $("voiceVolumeMeter").hidden = state !== "recording" && state !== "paused";
    const status = $("voiceChatStatus");
    const statusKey = {
      starting: "voiceRecordingRequestingMic",
      recording: "voiceRecordingActive",
      paused: "voiceRecordingPaused",
      stopping: "voiceRecordingReady",
      saving: "voiceRecordingSending"
    }[state];
    if (statusKey) {
      status.textContent = text(statusKey);
      status.hidden = false;
      status.dataset.error = "";
      status.dataset.persistent = "";
    } else if (state === "idle" && !status.dataset.error && !status.dataset.persistent) {
      status.textContent = "";
      status.hidden = true;
    }
    document.getElementById("voiceChatLabel").textContent =
      isRecording ? "Pause" : isPaused ? "Resume" : state === "starting" ? "Starting…" : state === "stopping" ? "Finishing…" : state === "saving" ? "Sending…" : "Start";
    button.setAttribute("aria-pressed", String(isRecording));
    const label = isRecording ? "Pause" : isPaused ? "Resume" : state === "starting" ? "Starting" : state === "stopping" ? "Finishing" : state === "saving" ? "Sending" : "Start";
    button.setAttribute("aria-label", `${label} voice recording`);
    button.title = `${label} voice recording`;
    button.disabled = state === "starting" || state === "stopping" || state === "saving" || Boolean(pendingVoiceBlob);
  }

  function clearPendingVoice(statusKey = null) {
    pendingVoiceBlob = null;
    pendingVoiceChatIndex = null;
    $("voiceMessagePreview").hidden = true;
    $("voiceMessagePreviewAudio").pause();
    $("voiceMessagePreviewAudio").removeAttribute("src");
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    voicePreviewUrl = null;
    const status = $("voiceChatStatus");
    status.dataset.error = "";
    status.dataset.persistent = statusKey ? "true" : "";
    if (statusKey) {
      status.textContent = text(statusKey);
      status.hidden = false;
    }
    updateVoiceButton();
  }

  function updateVolumeMeter() {
    if (!analyser || recorder?.state !== "recording") {
      volumeFrame = 0;
      return;
    }
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    let totalSquare = 0;
    const bars = $("voiceLiveWaveform").children;
    for (let index = 0; index < bars.length; index += 1) {
      const start = Math.floor((index / bars.length) * samples.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / bars.length) * samples.length));
      let barSquare = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const amplitude = (samples[sampleIndex] - 128) / 128;
        const square = amplitude * amplitude;
        barSquare += square;
        totalSquare += square;
      }
      const barLevel = Math.sqrt(barSquare / (end - start));
      bars[index].style.height = `${Math.max(8, Math.round(barLevel * 170))}%`;
    }
    const level = Math.min(100, Math.round(Math.sqrt(totalSquare / samples.length) * 300));
    $("voiceVolumeLevel").style.width = `${level}%`;
    $("voiceVolumeValue").textContent = `${level}%`;
    volumeFrame = requestAnimationFrame(updateVolumeMeter);
  }

  async function sendVoiceMessage(blob, chatIndex) {
    try {
      if (!blob.size) {
        showContactToast("Voice recording", "", "No audio was captured. Check microphone permission and try again.");
        return false;
      }
      if (!chats[chatIndex] || !currentAccount) return false;
      const chat = chats[chatIndex];
      const state = readContactState();
      if (state[chat.name]?.blocked || state[chat.name]?.deleted ||
        (chat.accountEmail && state.accountBlocks?.[chat.accountEmail])) return false;

      const id = crypto.randomUUID();
      const type = blob.type || "audio/webm";
      const name = `voice-message-${Date.now()}.${type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"}`;
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("attachments", "readwrite");
        transaction.objectStore("attachments").add({
          id,
          ownerEmail: currentAccount.email,
          chatName: chat.name,
          name,
          type,
          size: blob.size,
          blob
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("The browser could not save the voice message."));
        transaction.onabort = () => reject(transaction.error || new Error("The browser cancelled saving the voice message."));
      });
      const message = {
        attachmentId: id,
        name,
        type,
        size: blob.size,
        text: name,
        mine: true,
        replyTo: pendingReply?.chatIndex === chatIndex ? { text: pendingReply.text } : null,
        sentAt: Date.now()
      };
      chat.messages.push(message);
      chat.preview = "🎤 Voice message";
      if (pendingReply?.chatIndex === chatIndex) clearReplyTarget();
      saveChats();
      if (activeChat === chatIndex) drawMessages();
      renderChats($("search").value);
      showContactToast(chat.name, chat.color, "Voice message sent.");
      $("voiceChatStatus").dataset.error = "";
      $("voiceChatStatus").textContent = text("voiceRecordingSent");
      $("voiceChatStatus").hidden = false;
      return true;
    } catch (error) {
      $("messageUploadError").textContent = `${text("uploadFailed")} ${error.message || ""}`;
      $("messageUploadError").hidden = false;
      console.error("Could not save the recorded voice message.", error);
      $("voiceChatStatus").dataset.error = "true";
      $("voiceChatStatus").dataset.persistent = "true";
      $("voiceChatStatus").textContent = `${text("uploadFailed")} ${error.message || ""}`;
      $("voiceChatStatus").hidden = false;
      return false;
    }
  }

  async function startRecording() {
    if (isStarting || isStopping || isSaving || pendingVoiceBlob) return;
    if (!chats[activeChat]) ensureNotesChat();
    const chat = chats[activeChat];
    const contactState = readContactState();
    if (!chat || contactState[chat.name]?.blocked || contactState[chat.name]?.deleted ||
      (chat.accountEmail && contactState.accountBlocks?.[chat.accountEmail])) {
      showContactToast("Voice recording", "", "Choose an available conversation before recording.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const message = "Microphone access requires HTTPS or localhost in a supported browser.";
      $("voiceChatStatus").dataset.error = "true";
      $("voiceChatStatus").dataset.persistent = "true";
      $("voiceChatStatus").textContent = message;
      $("voiceChatStatus").hidden = false;
      showContactToast("Voice recording", "", message);
      return;
    }
    if (!window.MediaRecorder) {
      const message = "This browser does not support audio recording.";
      $("voiceChatStatus").dataset.error = "true";
      $("voiceChatStatus").dataset.persistent = "true";
      $("voiceChatStatus").textContent = message;
      $("voiceChatStatus").hidden = false;
      showContactToast("Voice recording", "", message);
      return;
    }

    try {
      button.dataset.state = "starting";
      $("voiceChatStatus").dataset.error = "";
      $("voiceChatStatus").dataset.persistent = "";
      isStarting = true;
      updateVoiceButton();
      recordingChatIndex = activeChat;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        try {
          audioContext = new AudioContextClass();
          await audioContext.resume();
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.72;
          audioContext.createMediaStreamSource(micStream).connect(analyser);
        } catch (error) {
          analyser = null;
          console.error("Live microphone volume display is unavailable.", error);
          if (audioContext && audioContext.state !== "closed") {
            try {
              await audioContext.close();
            } catch (closeError) {
              console.error("Could not close the unavailable volume monitor.", closeError);
            }
          }
          audioContext = null;
        }
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
      audioChunks = [];
      recorder.addEventListener("dataavailable", event => {
        if (event.data.size) audioChunks.push(event.data);
      });
      recorder.addEventListener("start", () => {
        updateVoiceButton();
        updateVolumeMeter();
      });
      recorder.addEventListener("pause", updateVoiceButton);
      recorder.addEventListener("resume", updateVoiceButton);
      recorder.addEventListener("stop", async () => {
        isStarting = false;
        isStopping = false;
        updateVoiceButton();
        if (volumeFrame) cancelAnimationFrame(volumeFrame);
        const blob = new Blob(audioChunks, { type: recorder.mimeType || "audio/webm" });
        audioChunks = [];
        micStream?.getTracks().forEach(track => track.stop());
        micStream = null;
        if (audioContext && audioContext.state !== "closed") {
          try {
            await audioContext.close();
          } catch (error) {
            console.error("Could not close the voice volume monitor.", error);
          }
        }
        audioContext = null;
        analyser = null;
        pendingVoiceChatIndex = recordingChatIndex;
        recordingChatIndex = null;
        if (blob.size) {
          pendingVoiceBlob = blob;
          voicePreviewUrl = URL.createObjectURL(blob);
          $("voiceMessagePreviewAudio").src = voicePreviewUrl;
          $("voiceMessagePreview").hidden = false;
          $("voiceChatStatus").dataset.persistent = "true";
          $("voiceChatStatus").textContent = text("voiceRecordingReady");
          $("voiceChatStatus").hidden = false;
        } else {
          $("voiceChatStatus").dataset.error = "true";
          $("voiceChatStatus").dataset.persistent = "true";
          $("voiceChatStatus").textContent = "No audio was captured. Check microphone permission and try again.";
          $("voiceChatStatus").hidden = false;
          showContactToast("Voice recording", "", "No audio was captured. Check microphone permission and try again.");
        }
        updateVoiceButton();
      });
      recorder.start(250);
      isStarting = false;
      updateVoiceButton();
    } catch (error) {
      isStarting = false;
      recorder = null;
      micStream?.getTracks().forEach(track => track.stop());
      micStream = null;
      if (audioContext && audioContext.state !== "closed") {
        try {
          await audioContext.close();
        } catch (closeError) {
          console.error("Could not close the voice volume monitor.", closeError);
        }
      }
      audioContext = null;
      updateVoiceButton();
      console.error("Could not start voice recording.", error);
      const message = `Could not start recording: ${error.message || "microphone permission was denied."}`;
      $("voiceChatStatus").dataset.error = "true";
      $("voiceChatStatus").dataset.persistent = "true";
      $("voiceChatStatus").textContent = message;
      $("voiceChatStatus").hidden = false;
      showContactToast("Voice recording", "", message);
    }
  }

  button.addEventListener("click", async () => {
    if (recorder?.state === "recording") {
      recorder.pause();
      micStream?.getAudioTracks().forEach(track => { track.enabled = false; });
      if (volumeFrame) cancelAnimationFrame(volumeFrame);
      volumeFrame = 0;
      $("voiceVolumeLevel").style.width = "0%";
      $("voiceVolumeValue").textContent = "0%";
      Array.from($("voiceLiveWaveform").children).forEach(bar => { bar.style.height = "8%"; });
      updateVoiceButton();
    } else if (recorder?.state === "paused") {
      micStream?.getAudioTracks().forEach(track => { track.enabled = true; });
      recorder.resume();
      updateVoiceButton();
    } else {
      await startRecording();
    }
    updateVoiceButton();
  });

  stopButton.addEventListener("click", () => {
    if (recorder && recorder.state !== "inactive") {
      isStopping = true;
      stopButton.disabled = true;
      stopButton.textContent = "Finishing…";
      updateVoiceButton();
      recorder.stop();
    }
  });

  $("sendVoiceMessageBtn").addEventListener("click", async () => {
    if (!pendingVoiceBlob || isSaving) return;
    isSaving = true;
    $("sendVoiceMessageBtn").disabled = true;
    $("sendVoiceMessageBtn").textContent = "Sending…";
    updateVoiceButton();
    try {
      const sent = await sendVoiceMessage(pendingVoiceBlob, pendingVoiceChatIndex);
      if (sent) clearPendingVoice("voiceRecordingSent");
    } finally {
      isSaving = false;
      $("sendVoiceMessageBtn").disabled = false;
      $("sendVoiceMessageBtn").textContent = "Send voice";
      updateVoiceButton();
    }
  });

  $("discardVoiceMessageBtn").addEventListener("click", () => clearPendingVoice("voiceRecordingDiscarded"));

  window.addEventListener("pagehide", () => {
    if (volumeFrame) cancelAnimationFrame(volumeFrame);
    if (recorder?.state !== "inactive") recorder.stop();
    micStream?.getTracks().forEach(track => track.stop());
  });

  updateVoiceButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVoiceChatButton);
} else {
  initVoiceChatButton();
}

const translations = {
  en: {
    welcome: "Welcome to BlackMessage", authNotice: "Your account and conversations are stored on this device. Email codes are shown on screen and are not sent.",
    firstWelcomeTitle: "Welcome to BlackMessage",
    firstWelcomeDescription: "Your account is ready. Start chatting whenever you’re ready.", startApp: "Start",
    signIn: "Sign in", createAccount: "Create account", displayName: "Display name",
    namePlaceholder: "Your name", emailAddress: "Email address", emailPlaceholder: "you@example.com",
    orContinue: "or continue", language: "Language", search: "⌕ Search chats, users and friends",
    findFriends: "⌕ Find friends", findFriendsTitle: "Find friends", friendCenter: "Friends", nearbyAddFriend: "Add a nearby friend", yourFriendCode: "Your friend QR code", copyFriendCode: "Copy code", addFriendByCode: "Scan a friend’s QR or enter their code", scanFriendQr: "Scan QR with camera", chooseQrImage: "Choose QR image", friendCodeLabel: "Friend code", friendCodePlaceholder: "BM2|random-code|username|name", nearbyFriendLimit: "Scan or share a QR code to add a contact on this device. This does not connect devices or sync messages.", friendQrCopied: "Friend code copied.", friendQrAdded: "Added {name} to your contacts on this device.", invalidFriendQr: "That QR or friend code is invalid.", qrCameraUnavailable: "Camera scanning requires a supported browser and a secure page (HTTPS or localhost). You can choose a QR image or enter its code instead.", friendQrCameraError: "Could not open the camera. Check camera permission and try again.", nearbyProfilePhotoNote: "A profile photo is shown when available on this device. QR codes do not transfer photos between devices.", noThanks: "No thanks", nearbyFriendBlocked: "{name} is blocked on this device.", nearbyFriendUnblocked: "{name} is no longer blocked on this device.",
    friendCenterCount: "Friends ({count})", friendRequests: "Requests", blockedFriends: "Blocked",
    friendRequestsCount: "Requests ({count})", friendRequestNotification: "You received a friend request.", friendRequestsDescription: "Review requests people sent you.",
    blockedFriendsDescription: "People you blocked cannot message you.", friendAccepted: "You and {name} are now friends.",
    requestSent: "Request sent", acceptRequest: "Accept", rejectRequest: "No", noFriendRequests: "No friend requests yet.",
    noBlockedFriends: "You haven’t blocked anyone.", requestReceived: "{name} sent you a friend request.", people: "People", groups: "Groups", bots: "Bots",
    friendSearchPlaceholder: "Search by name or username",
    usersAndFriends: "Users and friends",
    localAccounts: "Local accounts", accountSearchNote: "Search accounts saved in this browser only.",
    noLocalAccounts: "No other matching local accounts.", noOtherAccounts: "No other accounts are saved in this browser yet.",
    noGroupsFound: "No matching groups found.", noBotsFound: "No matching bots found.",
    ownAccountProfile: "Your profile",
    accountMenu: "Actions for {name}",
    accountPrivate: "Private", accountGlobal: "Global",
    openingAccount: "Opening your account…", savingAccount: "Saving your account…",
    requireAppPin: "Require a 4-digit code", appPinHelp: "Ask for your code when you reopen the app",
    setupPinTitle: "Set your app code", setupPinDescription: "Create a 4-digit code to protect this app on this device.",
    unlockPinTitle: "Unlock BlackMessage", unlockPinDescription: "Enter your 4-digit code to continue.",
    resetPinTitle: "Choose a new app code", resetPinDescription: "Enter a new 4-digit code and confirm it below.",
    fourDigitCode: "4-digit code", confirmFourDigitCode: "Confirm 4-digit code",
    saveAppPin: "Save code", unlockApp: "Unlock", forgotAppPin: "Forgot code?",
    pinRecoveryNotice: "A six-digit recovery code will be shown here. No email is sent.",
    invalidAppPin: "That code is incorrect. Try again.", pinMismatch: "The codes do not match.",
    pinMustBeFourDigits: "Enter exactly 4 digits.",
    invalidPinRecoveryCode: "That verification code is incorrect. Try again.",
    lockApp: "Lock app",
    messages: "Messages", myFiles: "My files", localAccount: "Account",
    demoChat: "● conversation", writeMessage: "Write a message…", send: "Send",
    trySomething: "Try sending a message, recording a voice note, or uploading a file.",
    myNotes: "My notes",
    backToChat: "← Back to chat", mobileMenu: "Open menu", closeMobileMenu: "Close menu", filesNotice: "Files are stored in this browser on this device.",
    newFolder: "New folder", folderPlaceholder: "Folder name", createFolder: "Create folder",
    uploadFiles: "＋ Add files", settings: "Settings", settingsNotice: "Customize your app.",
    colorTheme: "Color theme", themeHelp: "Choose light or dark mode",
    reduceMotion: "Reduce animations", motionHelp: "Turn off interface motion", done: "Done",
    messageSound: "Incoming message sound", soundHelp: "Play a tone for incoming replies",
    languageHelp: "Choose the interface language", emptyFolder: "No files in this folder yet.",
    noFolders: "Create a folder to organize your files.", delete: "Delete", download: "Download",
    signOut: "Sign out", accountCreated: "Your account is ready.",
    emailAlreadyUsed: "A local account already uses this email. Please sign in.",
    accountMissing: "No local account found for that email. Choose Create account first.",
    nameRequired: "Enter a valid email address to create an account.", storageError: "Browser storage is unavailable or full. Please try smaller files or another browser.",
    incomingReply: "Thanks for your message!", today: "TODAY", noChats: "No conversations found",
    copyFailed: "Could not copy. Check clipboard permissions.",     copied: "Copied to clipboard", fileCount: "{count} files", oneFile: "1 file",
    codeStudio: "Code Studio", myProject: "/ My project", copy: "Copy",
    explorer: "Explorer", readySaved: "Ready · saved in this browser",
    light: "Light", dark: "Dark", openCode: "Open Code Studio", toggleTheme: "Toggle dark mode",
    offlineTitle: "Connection unavailable", offlineMessage: "Your device appears to be offline. Check your internet connection and try again.",
    retry: "Try again", verifyEmail: "Verify your email", verificationDemo: "No email is sent. Enter the code shown here:",
    sixDigitCode: "Six-digit code", codePlaceholder: "000000", verify: "Verify", back: "Back",
    resendCode: "New code", invalidCode: "That code does not match. Try again.",
    emailVerified: "Email verified.", verificationStarted: "Enter the code shown here.",
    codeLanguage: "C#",
    friendOptions: "Friend options", contactDemoNotice: "These settings apply to your account on this device.",
    blockFriend: "Block friend", unblockFriend: "Unblock friend", removeFriend: "Remove friend",
    simulateBlock: "Show block notification", blockedStatus: "You blocked {name}.",
    unblockedStatus: "You unblocked {name}.", removedStatus: "{name} was removed from your chats.",
    blockedByStatus: "{name} blocked you.", wantsToTalk: "wants to talk to you",
    friendBlocked: "This friend is blocked. Unblock them to send a message.",
    dismiss: "Dismiss", contactRemoved: "Messages",
    myMessageColor: "My message color", myMessageColorHelp: "Customize sent message bubbles",
    friendMessageColor: "Friend message color", friendMessageColorHelp: "Customize received message bubbles",
    profilePrivacy: "Profile visibility", privacyHelp: "Choose who can see your profile",
    privateProfile: "Private", globalProfile: "Global", profileSettings: "Profile",
    changePhoto: "Choose profile photo", privacyDemoNotice: "Profile visibility is saved with your account on this device.",
    cancel: "Cancel", save: "Save", imageTooLarge: "Choose an image smaller than 2 MB.",
    profileSaved: "Profile saved.", profileMenu: "Open profile menu",
    followers: "Followers", friends: "Friends", views: "Views", likes: "Likes",
    aboutProfile: "About", sharedPhotos: "Photos", profileDemoCounts: "Profile statistics and activity.",
    profileVisibility: "Profile visibility", profileVisibilityHelp: "Choose who can see your profile",
    aboutHelp: "Shown on your profile", aboutPlaceholder: "A little about you",
    likeProfile: "Like profile", likedProfile: "Liked", moreActions: "More actions",
    viewProfile: "View profile", publicProfile: "Public profile", privateProfileNotice: "This profile is private.",
    profileViewed: "Profile viewed", followerCount: "follower", friendCount: "friend", photoCount: "photos",
    demoProfileBio: "BlackMessage member", profileOf: "Profile of {name}", cannotAccessPrivate: "This profile is set to private.",
    friendMenuLabel: "More actions for {name}",
    global: "Global", private: "Private",
    following: "Following", follow: "Follow", liked: "Liked", like: "Like",
    profileUnavailable: "This profile is not available.", ownProfile: "Your profile",
    profileActionFollow: "Follow", profileActionLike: "Like profile",
    createGroup: "＋ Create group", openBot: "✦ Open BlackMessage bot", posts: "Posts",
    postsPrivateNote: "Posts are saved on this device and are not published online.", createPost: "＋ Create post",
    postCaption: "Write a caption", publishPost: "Publish", postSaved: "Post published.",
    postGlobalOnly: "Set your profile to Global to publish posts.", noPosts: "No posts yet.",
    removePost: "Delete post", hideProfile: "Hide my profile from this friend",
    showProfileToFriend: "Show my profile to this friend", groupDemoNotice: "Create a group conversation. Members are listed by name.",
    hideFriendProfile: "Hide this friend's profile", showFriendProfile: "Show this friend's profile",
    editProfile: "Edit profile", profileHidden: "This friend has chosen not to show this profile.",
    groupExists: "A conversation already uses this name.",
    groupName: "Group name", groupNamePlaceholder: "e.g. Project team",
    groupMembers: "Members (separate names with commas)", groupMembersPlaceholder: "Alex, Sam",
    botChatName: "BlackMessage bot", botWelcome: "Hi! I’m the BlackMessage bot. What would you like to chat about?",
    postTooLarge: "Each post file must be 5 MB or smaller.", postMediaOnly: "Choose image or video files.",
    memberLabel: "Members", botReply: "Thanks for your message!",
    originalQualityNote: "Files are not compressed. A 500 MB file can be selected, but saving depends on available browser storage; files stay on this device.",
    attachFiles: "Attach files", uploadFailed: "Could not store these files in browser storage.", uploadFilesLabel: "Uploading files…",
    downloadFile: "Download", fileSize: "{size} MB", messageActions: "Message actions",
    playVoiceMessage: "Play voice message", pauseVoiceMessage: "Pause voice message",
    voiceMessagePlaybackFailed: "This voice message could not be played.",
    voiceRecordingRequestingMic: "Allow microphone access in your browser to record.",
    voiceRecordingActive: "Recording… speak now.",
    voiceRecordingPaused: "Recording paused.",
    voiceRecordingReady: "Recording ready. Preview it, then send or discard.",
    voiceRecordingSending: "Sending voice message…",
    voiceRecordingSent: "Voice message sent.",
    voiceRecordingDiscarded: "Voice recording discarded.",
    viewMedia: "View media", replyMessage: "Reply", replyingTo: "Replying to",
    editMessage: "Edit message", editMessageTitle: "Edit your message", editedMessageEmpty: "Message cannot be empty.",
    pinMessage: "Pin", unpinMessage: "Unpin", pinnedMessage: "Pinned message",
    blurImage: "Blur image", unblurImage: "Unblur image", deleteMessage: "Delete message",
    filterMessages: "Filter messages", filterPlaceholder: "Filter this conversation",
    copyMessage: "Copy message", messageCopyFailed: "Could not copy this message. Check clipboard permissions.",
    noMatchingMessages: "No messages match this filter.", clearMessageFilter: "Clear message filter",
    username: "Username", joinedOn: "Joined {date}", developerBadge: "App developer",
    addFriend: "＋ Add friend",
    friendName: "Friend name", friendNamePlaceholder: "Enter a name", friendExists: "A friend with this name already exists.",
    followedNotice: "You followed {name}.", followerNotification: "{name} started following your profile.",
    blockedNotice: "You blocked {name}.",
    newFriendNotice: "{name} was added to your friends.",
    renameVerificationNote: "Changing your name requires verifying the same email address again.",
    verificationForName: "To change your name, verify this email address again: {email}",
    duplicateDisplayName: "That display name is already in use by another account.",
    nameChanged: "Display name updated after email verification.",
    invalidDisplayName: "Enter a display name between 2 and 32 characters.",
    simulateFollower: "Show a follower notification", newFollowerName: "New follower",
    newFollowerNotice: "A new follower started following your profile."
  },
  fr: {
    welcome: "Bienvenue sur BlackMessage", authNotice: "Votre compte et vos conversations sont enregistrés sur cet appareil. Les codes e-mail s’affichent à l’écran et ne sont pas envoyés.",
    firstWelcomeTitle: "Bienvenue sur BlackMessage",
    firstWelcomeDescription: "Votre compte est prêt. Vous pouvez commencer à discuter.", startApp: "Commencer",
    signIn: "Connexion", createAccount: "Créer un compte", displayName: "Nom affiché",
    namePlaceholder: "Votre nom", emailAddress: "Adresse e-mail", emailPlaceholder: "vous@exemple.com",
    orContinue: "ou continuer", language: "Langue", search: "⌕ Rechercher discussions, utilisateurs et amis",
    findFriends: "⌕ Trouver des amis", findFriendsTitle: "Trouver des amis", friendCenter: "Amis", friendCenterCount: "Amis ({count})", nearbyAddFriend: "Ajouter un ami à proximité", yourFriendCode: "Votre QR code d’ami", copyFriendCode: "Copier le code", addFriendByCode: "Scannez le QR d’un ami ou saisissez son code", scanFriendQr: "Scanner avec la caméra", chooseQrImage: "Choisir une image QR", friendCodeLabel: "Code de l’ami", friendCodePlaceholder: "BM2|code-aléatoire|nom_utilisateur|nom", nearbyFriendLimit: "Scannez ou partagez un QR code pour ajouter un contact sur cet appareil. Cela ne connecte pas les appareils et ne synchronise pas les messages.", friendQrCopied: "Code d’ami copié.", friendQrAdded: "{name} a été ajouté à vos contacts sur cet appareil.", invalidFriendQr: "Ce QR code ou code d’ami n’est pas valide.", qrCameraUnavailable: "Le scan par caméra nécessite un navigateur compatible et une page sécurisée (HTTPS ou localhost). Vous pouvez choisir une image QR ou saisir son code.", friendQrCameraError: "Impossible d’ouvrir la caméra. Vérifiez l’autorisation puis réessayez.", nearbyProfilePhotoNote: "La photo de profil s’affiche si elle est disponible sur cet appareil. Le QR ne transfère pas les photos entre appareils.", noThanks: "Non merci", nearbyFriendBlocked: "{name} est bloqué sur cet appareil.", nearbyFriendUnblocked: "{name} n’est plus bloqué sur cet appareil.",
    friendRequests: "Demandes", blockedFriends: "Bloqués",
    friendRequestsCount: "Demandes ({count})", friendRequestNotification: "Vous avez reçu une demande d’ami.", friendRequestsDescription: "Consultez les demandes que vous avez reçues.",
    blockedFriendsDescription: "Les personnes bloquées ne peuvent pas vous envoyer de messages.", friendAccepted: "Vous êtes maintenant ami(e) avec {name}.",
    requestSent: "Demande envoyée", acceptRequest: "Accepter", rejectRequest: "Non", noFriendRequests: "Aucune demande d’ami pour le moment.",
    noBlockedFriends: "Vous n’avez bloqué personne.", requestReceived: "{name} vous a envoyé une demande d’ami.",
    people: "Personnes", groups: "Groupes", bots: "Bots",
    friendSearchPlaceholder: "Rechercher par nom ou nom d’utilisateur", usersAndFriends: "Utilisateurs et amis",
    localAccounts: "Comptes locaux", accountSearchNote: "Recherche uniquement les comptes enregistrés dans ce navigateur.",
    noLocalAccounts: "Aucun autre compte local correspondant.",
    noOtherAccounts: "Aucun autre compte n’est encore enregistré dans ce navigateur.",
    noGroupsFound: "Aucun groupe correspondant.",
    noBotsFound: "Aucun bot correspondant.",
    ownAccountProfile: "Votre profil",
    accountPrivate: "Privé", accountGlobal: "Public",
    openingAccount: "Ouverture de votre compte…", savingAccount: "Enregistrement de votre compte…",
    requireAppPin: "Demander un code à 4 chiffres", appPinHelp: "Demander le code à la réouverture de l’application",
    setupPinTitle: "Créer votre code", setupPinDescription: "Créez un code à 4 chiffres pour protéger cette application sur cet appareil.",
    unlockPinTitle: "Déverrouiller BlackMessage", unlockPinDescription: "Saisissez votre code à 4 chiffres pour continuer.",
    resetPinTitle: "Choisir un nouveau code", resetPinDescription: "Saisissez un nouveau code à 4 chiffres et confirmez-le ci-dessous.",
    fourDigitCode: "Code à 4 chiffres", confirmFourDigitCode: "Confirmer le code à 4 chiffres",
    saveAppPin: "Enregistrer le code", unlockApp: "Déverrouiller", forgotAppPin: "Code oublié ?",
    pinRecoveryNotice: "Un code de récupération à six chiffres s’affichera ici. Aucun e-mail ne sera envoyé.",
    invalidAppPin: "Code incorrect. Réessayez.", pinMismatch: "Les codes ne correspondent pas.",
    pinMustBeFourDigits: "Saisissez exactement 4 chiffres.",
    invalidPinRecoveryCode: "Code de vérification incorrect. Réessayez.",
    lockApp: "Verrouiller l’application",
    messages: "Messages", myFiles: "Mes fichiers", localAccount: "Compte",
    demoChat: "● discussion", writeMessage: "Écrire un message…", send: "Envoyer",
    trySomething: "Envoyez un message, enregistrez une note vocale ou ajoutez un fichier.",
    myNotes: "Mes notes",
    backToChat: "← Retour à la discussion", mobileMenu: "Ouvrir le menu", closeMobileMenu: "Fermer le menu", filesNotice: "Les fichiers sont stockés dans ce navigateur sur cet appareil.",
    newFolder: "Nouveau dossier", folderPlaceholder: "Nom du dossier", createFolder: "Créer le dossier",
    uploadFiles: "＋ Ajouter des fichiers", settings: "Paramètres", settingsNotice: "Personnalisez l’application.",
    colorTheme: "Thème de couleur", themeHelp: "Choisir le mode clair ou sombre",
    reduceMotion: "Réduire les animations", motionHelp: "Désactiver les animations", done: "Terminé",
    messageSound: "Son des messages reçus", soundHelp: "Jouer un son pour les réponses reçues",
    languageHelp: "Choisir la langue de l’interface", emptyFolder: "Ce dossier ne contient aucun fichier.",
    noFolders: "Créez un dossier pour organiser vos fichiers.", delete: "Supprimer", download: "Télécharger",
    signOut: "Déconnexion", accountCreated: "Votre compte est prêt.",
    emailAlreadyUsed: "Cette adresse utilise déjà un compte local. Veuillez vous connecter.",
    accountMissing: "Aucun compte local pour cette adresse. Choisissez d’abord Créer un compte.",
    nameRequired: "Saisissez une adresse e-mail valide pour créer un compte.", storageError: "Le stockage du navigateur est indisponible ou plein. Essayez des fichiers plus petits ou un autre navigateur.",
    incomingReply: "Merci pour votre message !", today: "AUJOURD’HUI", noChats: "Aucune conversation trouvée",
    copyFailed: "Copie impossible. Vérifiez les autorisations du presse-papiers.",     copied: "Copié dans le presse-papiers", fileCount: "{count} fichiers", oneFile: "1 fichier",
    codeStudio: "Studio de code", myProject: "/ Mon projet", copy: "Copier",
    explorer: "Explorateur", readySaved: "Prêt · enregistré dans ce navigateur",
    light: "Clair", dark: "Sombre", openCode: "Ouvrir le studio de code", toggleTheme: "Changer le thème",
    offlineTitle: "Connexion indisponible", offlineMessage: "Votre appareil semble hors ligne. Vérifiez votre connexion Internet et réessayez.",
    retry: "Réessayer", verifyEmail: "Vérifiez votre e-mail", verificationDemo: "Aucun e-mail n’est envoyé. Saisissez le code affiché ici :",
    sixDigitCode: "Code à six chiffres", codePlaceholder: "000000", verify: "Vérifier", back: "Retour",
    resendCode: "Nouveau code", invalidCode: "Ce code ne correspond pas. Réessayez.",
    emailVerified: "E-mail vérifié.", verificationStarted: "Saisissez le code affiché ici.",
    codeLanguage: "C#",
    friendOptions: "Options de contact", contactDemoNotice: "Ces paramètres s’appliquent à votre compte sur cet appareil.",
    blockFriend: "Bloquer le contact", unblockFriend: "Débloquer le contact", removeFriend: "Supprimer le contact",
    simulateBlock: "Afficher une notification de blocage", blockedStatus: "Vous avez bloqué {name}.",
    unblockedStatus: "Vous avez débloqué {name}.", removedStatus: "{name} a été supprimé de vos discussions.",
    blockedByStatus: "{name} vous a bloqué.", wantsToTalk: "veut vous parler",
    friendBlocked: "Ce contact est bloqué. Débloquez-le pour envoyer un message.",
    dismiss: "Fermer", contactRemoved: "Messages",
    myMessageColor: "Couleur de mes messages", myMessageColorHelp: "Personnaliser les bulles envoyées",
    friendMessageColor: "Couleur des messages reçus", friendMessageColorHelp: "Personnaliser les bulles reçues",
    profilePrivacy: "Visibilité du profil", privacyHelp: "Choisir qui peut voir votre profil",
    privateProfile: "Privé", globalProfile: "Public", profileSettings: "Profil",
    changePhoto: "Choisir une photo de profil", privacyDemoNotice: "La visibilité du profil est enregistrée avec votre compte sur cet appareil.",
    cancel: "Annuler", save: "Enregistrer", imageTooLarge: "Choisissez une image de moins de 2 Mo.",
    profileSaved: "Profil enregistré.", profileMenu: "Ouvrir le menu du profil",
    followers: "Abonnés", friends: "Amis", views: "Vues", likes: "J’aime",
    aboutProfile: "À propos", sharedPhotos: "Photos", profileDemoCounts: "Statistiques et activité du profil.",
    profileVisibility: "Visibilité du profil", profileVisibilityHelp: "Choisir qui peut voir votre profil",
    aboutHelp: "Visible sur votre profil", aboutPlaceholder: "Quelques mots sur vous",
    likeProfile: "Aimer le profil", likedProfile: "Aimé", moreActions: "Plus d’options",
    viewProfile: "Voir le profil", publicProfile: "Profil public", privateProfileNotice: "Ce profil est privé.",
    profileViewed: "Profil consulté", followerCount: "abonné", friendCount: "ami", photoCount: "photos",
    demoProfileBio: "Membre BlackMessage", profileOf: "Profil de {name}", cannotAccessPrivate: "Ce profil est privé.",
    friendMenuLabel: "Plus d’options pour {name}",
    global: "Public", private: "Privé", following: "Abonné", follow: "Suivre",
    liked: "Aimé", like: "J’aime", profileUnavailable: "Ce profil n’est pas disponible.",
    ownProfile: "Votre profil", profileActionFollow: "Suivre", profileActionLike: "Aimer le profil",
    createGroup: "＋ Créer un groupe", openBot: "✦ Ouvrir le bot BlackMessage", posts: "Publications",
    postsPrivateNote: "Les publications sont enregistrées sur cet appareil et ne sont pas publiées en ligne.", createPost: "＋ Créer une publication",
    postCaption: "Écrire une légende", publishPost: "Publier", postSaved: "Publication publiée.",
    postGlobalOnly: "Passez votre profil en mode public pour publier.", noPosts: "Aucune publication.",
    removePost: "Supprimer la publication", hideProfile: "Masquer mon profil à ce contact",
    showProfileToFriend: "Montrer mon profil à ce contact", groupDemoNotice: "Créer une conversation de groupe. Les membres sont affichés par nom.",
    hideFriendProfile: "Masquer le profil de ce contact", showFriendProfile: "Afficher le profil de ce contact",
    editProfile: "Modifier le profil", profileHidden: "Ce contact a choisi de ne pas afficher ce profil.",
    groupExists: "Une conversation utilise déjà ce nom.",
    groupName: "Nom du groupe", groupNamePlaceholder: "Ex. Équipe projet",
    groupMembers: "Membres (séparés par des virgules)", groupMembersPlaceholder: "Alex, Sam",
    botChatName: "Bot BlackMessage", botWelcome: "Bonjour ! Je suis le bot BlackMessage. De quoi voulez-vous parler ?",
    postTooLarge: "Chaque fichier doit faire 5 Mo ou moins.", postMediaOnly: "Choisissez des images ou des vidéos.",
    memberLabel: "Membres", botReply: "Merci pour votre message !",
    originalQualityNote: "Aucune compression. Un fichier de 500 Mo peut être sélectionné, mais son enregistrement dépend de l’espace du navigateur ; il reste sur cet appareil.",
    attachFiles: "Joindre des fichiers", uploadFailed: "Impossible de stocker ces fichiers dans le navigateur.", uploadFilesLabel: "Envoi des fichiers…",
    downloadFile: "Télécharger", fileSize: "{size} Mo", messageActions: "Actions du message",
    playVoiceMessage: "Lire le message vocal", pauseVoiceMessage: "Mettre le message vocal en pause",
    voiceMessagePlaybackFailed: "Impossible de lire ce message vocal.",
    voiceRecordingRequestingMic: "Autorisez l’accès au microphone dans le navigateur pour enregistrer.",
    voiceRecordingActive: "Enregistrement… parlez maintenant.",
    voiceRecordingPaused: "Enregistrement en pause.",
    voiceRecordingReady: "Enregistrement prêt. Écoutez-le, puis envoyez-le ou supprimez-le.",
    voiceRecordingSending: "Envoi du message vocal…",
    voiceRecordingSent: "Message vocal envoyé.",
    voiceRecordingDiscarded: "Enregistrement vocal supprimé.",
    viewMedia: "Voir le média", replyMessage: "Répondre", replyingTo: "En réponse à",
    editMessage: "Modifier le message", editMessageTitle: "Modifier votre message", editedMessageEmpty: "Le message ne peut pas être vide.",
    pinMessage: "Épingler", unpinMessage: "Désépingler", pinnedMessage: "Message épinglé",
    blurImage: "Flouter l’image", unblurImage: "Rétablir l’image", deleteMessage: "Supprimer le message",
    filterMessages: "Filtrer les messages", filterPlaceholder: "Filtrer cette conversation",
    copyMessage: "Copier le message", messageCopyFailed: "Copie impossible. Vérifiez les autorisations du presse-papiers.",
    noMatchingMessages: "Aucun message ne correspond à ce filtre.", clearMessageFilter: "Effacer le filtre",
    username: "Nom d’utilisateur", joinedOn: "Inscrit le {date}", developerBadge: "Développeuse de l’application",
    addFriend: "＋ Ajouter un contact",
    friendName: "Nom du contact", friendNamePlaceholder: "Saisir un nom", friendExists: "Un contact porte déjà ce nom.",
    followedNotice: "Vous suivez {name}.", followerNotification: "{name} a commencé à suivre votre profil.",
    blockedNotice: "Vous avez bloqué {name}.",
    newFriendNotice: "{name} a été ajouté à vos amis.",
    renameVerificationNote: "Pour modifier votre nom, vous devez vérifier à nouveau la même adresse e-mail.",
    verificationForName: "Pour modifier votre nom, vérifiez à nouveau cette adresse e-mail : {email}",
    duplicateDisplayName: "Ce nom est déjà utilisé par un autre compte.",
    nameChanged: "Nom affiché modifié après vérification de l’e-mail.",
    invalidDisplayName: "Saisissez un nom affiché de 2 à 32 caractères.",
    simulateFollower: "Afficher une notification d’abonnement", newFollowerName: "Nouvel abonné",
    newFollowerNotice: "Un nouvel abonné suit votre profil."
  },
  ar: {
    welcome: "مرحبًا بك في BlackMessage", authNotice: "يُحفظ حسابك ومحادثاتك على هذا الجهاز. تظهر رموز البريد على الشاشة ولا تُرسل.",
    firstWelcomeTitle: "مرحبًا بك في BlackMessage",
    firstWelcomeDescription: "حسابك جاهز. ابدأ المحادثة عندما تكون مستعدًا.", startApp: "ابدأ",
    signIn: "تسجيل الدخول", createAccount: "إنشاء حساب", displayName: "اسم العرض",
    namePlaceholder: "اسمك", emailAddress: "البريد الإلكتروني", emailPlaceholder: "you@example.com",
    orContinue: "أو جرّب النسخة المحلية", language: "اللغة", search: "⌕ ابحث في المحادثات والمستخدمين والأصدقاء",
    findFriends: "⌕ ابحث عن أصدقاء", findFriendsTitle: "ابحث عن أصدقاء", friendCenter: "الأصدقاء", friendCenterCount: "الأصدقاء ({count})", nearbyAddFriend: "إضافة صديق قريب", yourFriendCode: "رمز QR الخاص بك", copyFriendCode: "نسخ الرمز", addFriendByCode: "امسح رمز صديق أو أدخل رمزه", scanFriendQr: "مسح QR بالكاميرا", chooseQrImage: "اختيار صورة QR", friendCodeLabel: "رمز الصديق", friendCodePlaceholder: "BM2|رمز-عشوائي|اسم_المستخدم|الاسم", nearbyFriendLimit: "امسح رمز QR أو شاركه لإضافة جهة اتصال على هذا الجهاز. لا يؤدي ذلك إلى ربط الأجهزة أو مزامنة الرسائل.", friendQrCopied: "تم نسخ رمز الصديق.", friendQrAdded: "تمت إضافة {name} إلى جهات اتصالك على هذا الجهاز.", invalidFriendQr: "رمز QR أو رمز الصديق غير صالح.", qrCameraUnavailable: "يتطلب المسح بالكاميرا متصفحاً مدعوماً وصفحة آمنة (HTTPS أو localhost). يمكنك اختيار صورة QR أو إدخال رمزها.", friendQrCameraError: "تعذر فتح الكاميرا. تحقق من الإذن وحاول مرة أخرى.", nearbyProfilePhotoNote: "تظهر صورة الملف الشخصي إذا كانت متاحة على هذا الجهاز. لا تنقل رموز QR الصور بين الأجهزة.", noThanks: "لا، شكرًا", nearbyFriendBlocked: "تم حظر {name} على هذا الجهاز.", nearbyFriendUnblocked: "تم إلغاء حظر {name} على هذا الجهاز.",
    friendRequests: "طلبات الصداقة", blockedFriends: "المحظورون",
    friendRequestsCount: "الطلبات ({count})", friendRequestNotification: "لديك طلب صداقة جديد.", friendRequestsDescription: "راجع طلبات الصداقة التي وصلتك.",
    blockedFriendsDescription: "لا يمكن للأشخاص المحظورين مراسلتك.", friendAccepted: "أصبحت أنت و{name} صديقين الآن.",
    requestSent: "تم إرسال الطلب", acceptRequest: "اقبل", rejectRequest: "لا", noFriendRequests: "لا توجد طلبات صداقة حتى الآن.",
    noBlockedFriends: "لم تحظر أي شخص.", requestReceived: "أرسل لك {name} طلب صداقة.",
    people: "الأشخاص", groups: "المجموعات", bots: "الروبوتات",
    friendSearchPlaceholder: "ابحث بالاسم أو اسم المستخدم", usersAndFriends: "المستخدمون والأصدقاء",
    localAccounts: "الحسابات المحلية", accountSearchNote: "ابحث فقط في الحسابات المحفوظة في هذا المتصفح.",
    noLocalAccounts: "لا توجد حسابات محلية أخرى مطابقة.",
    noOtherAccounts: "لا توجد حسابات أخرى محفوظة في هذا المتصفح حتى الآن.",
    noGroupsFound: "لم يتم العثور على مجموعات مطابقة.",
    noBotsFound: "لم يتم العثور على روبوتات مطابقة.",
    ownAccountProfile: "ملفك الشخصي",
    accountPrivate: "خاص", accountGlobal: "عام",
    openingAccount: "جارٍ فتح حسابك…", savingAccount: "جارٍ حفظ حسابك…",
    requireAppPin: "طلب رمز من ٤ أرقام", appPinHelp: "طلب الرمز عند إعادة فتح التطبيق",
    setupPinTitle: "أنشئ رمز التطبيق", setupPinDescription: "أنشئ رمزًا من ٤ أرقام لحماية التطبيق على هذا الجهاز.",
    unlockPinTitle: "إلغاء قفل BlackMessage", unlockPinDescription: "أدخل الرمز المكوّن من ٤ أرقام للمتابعة.",
    resetPinTitle: "اختر رمزًا جديدًا", resetPinDescription: "أدخل رمزًا جديدًا من ٤ أرقام وأكّده في الخانة أدناه.",
    fourDigitCode: "رمز من ٤ أرقام", confirmFourDigitCode: "تأكيد الرمز المكوّن من ٤ أرقام",
    saveAppPin: "حفظ الرمز", unlockApp: "فتح القفل", forgotAppPin: "نسيت الرمز؟",
    pinRecoveryNotice: "سيظهر هنا رمز استرداد من ٦ أرقام. لن يتم إرسال بريد إلكتروني.",
    invalidAppPin: "الرمز غير صحيح. حاول مرة أخرى.", pinMismatch: "الرمزان غير متطابقين.",
    pinMustBeFourDigits: "أدخل ٤ أرقام بالضبط.",
    invalidPinRecoveryCode: "رمز التحقق غير صحيح. حاول مرة أخرى.",
    lockApp: "قفل التطبيق",
    messages: "الرسائل", myFiles: "ملفاتي", localAccount: "الحساب",
    demoChat: "● محادثة", writeMessage: "اكتب رسالة…", send: "إرسال",
    trySomething: "جرّب إرسال رسالة أو تسجيل رسالة صوتية أو تحميل ملف.",
    myNotes: "ملاحظاتي",
    backToChat: "← العودة إلى المحادثة", mobileMenu: "فتح القائمة", closeMobileMenu: "إغلاق القائمة", filesNotice: "تُحفظ الملفات في هذا المتصفح على هذا الجهاز.",
    newFolder: "مجلد جديد", folderPlaceholder: "اسم المجلد", createFolder: "إنشاء مجلد",
    uploadFiles: "＋ إضافة ملفات", settings: "الإعدادات", settingsNotice: "خصص التطبيق.",
    colorTheme: "السمة", themeHelp: "اختر الوضع الفاتح أو الداكن",
    reduceMotion: "تقليل الحركة", motionHelp: "إيقاف حركة الواجهة", done: "تم",
    messageSound: "صوت الرسائل الواردة", soundHelp: "تشغيل نغمة للردود الواردة",
    languageHelp: "اختر لغة الواجهة", emptyFolder: "لا توجد ملفات في هذا المجلد بعد.",
    noFolders: "أنشئ مجلدًا لتنظيم ملفاتك.", delete: "حذف", download: "تنزيل",
    signOut: "تسجيل الخروج", accountCreated: "أصبح حسابك جاهزًا.",
    emailAlreadyUsed: "يوجد حساب محلي بهذا البريد بالفعل. يرجى تسجيل الدخول.",
    accountMissing: "لا يوجد حساب محلي لهذا البريد. اختر إنشاء حساب أولًا.",
    nameRequired: "أدخل عنوان بريد إلكتروني صالحًا لإنشاء حساب.", storageError: "تخزين المتصفح غير متاح أو ممتلئ. جرّب ملفات أصغر أو متصفحًا آخر.",
    incomingReply: "شكرًا على رسالتك!", today: "اليوم", noChats: "لم يتم العثور على محادثات",
    copyFailed: "تعذّر النسخ. تحقق من أذونات الحافظة.", copied: "تم النسخ إلى الحافظة",
    fileCount: "{count} ملفات", oneFile: "ملف واحد",
    codeStudio: "استوديو البرمجة", myProject: "/ مشروعي", copy: "نسخ",
    explorer: "المستكشف", readySaved: "جاهز · محفوظ في هذا المتصفح",
    light: "فاتح", dark: "داكن", openCode: "فتح استوديو البرمجة", toggleTheme: "تغيير السمة",
    offlineTitle: "الاتصال غير متاح", offlineMessage: "يبدو أن جهازك غير متصل. تحقق من اتصال الإنترنت وحاول مرة أخرى.",
    retry: "إعادة المحاولة", verifyEmail: "تحقق من بريدك الإلكتروني", verificationDemo: "لن يُرسل بريد إلكتروني. أدخل الرمز الظاهر هنا:",
    sixDigitCode: "رمز من ستة أرقام", codePlaceholder: "000000", verify: "تحقق", back: "رجوع",
    resendCode: "رمز جديد", invalidCode: "الرمز غير صحيح. حاول مرة أخرى.",
    emailVerified: "تم التحقق من البريد الإلكتروني.", verificationStarted: "أدخل الرمز الظاهر هنا.",
    codeLanguage: "C#",
    friendOptions: "خيارات الصديق", contactDemoNotice: "تُطبّق هذه الإعدادات على حسابك في هذا الجهاز.",
    blockFriend: "حظر الصديق", unblockFriend: "إلغاء حظر الصديق", removeFriend: "إزالة الصديق",
    simulateBlock: "عرض إشعار الحظر", blockedStatus: "لقد حظرت {name}.",
    unblockedStatus: "ألغيت حظر {name}.", removedStatus: "تمت إزالة {name} من محادثاتك.",
    blockedByStatus: "قام {name} بحظرك.", wantsToTalk: "يريد التحدث إليك",
    friendBlocked: "هذا الصديق محظور. ألغِ حظره لإرسال رسالة.",
    dismiss: "إغلاق", contactRemoved: "الرسائل",
    myMessageColor: "لون رسائلي", myMessageColorHelp: "تخصيص فقاعات الرسائل المرسلة",
    friendMessageColor: "لون رسائل الأصدقاء", friendMessageColorHelp: "تخصيص فقاعات الرسائل الواردة",
    profilePrivacy: "خصوصية الملف الشخصي", privacyHelp: "اختر من يمكنه رؤية ملفك الشخصي",
    privateProfile: "خاص", globalProfile: "عام", profileSettings: "الملف الشخصي",
    changePhoto: "اختيار صورة الملف الشخصي", privacyDemoNotice: "إعداد الخصوصية محلي فقط وليس تحكمًا حقيقيًا في الوصول.",
    cancel: "إلغاء", save: "حفظ", imageTooLarge: "اختر صورة أصغر من 2 ميغابايت.",
    profileSaved: "تم حفظ الملف الشخصي.", profileMenu: "فتح قائمة الملف الشخصي",
    followers: "المتابعون", friends: "الأصدقاء", views: "المشاهدات", likes: "الإعجابات",
    aboutProfile: "نبذة", sharedPhotos: "الصور", profileDemoCounts: "إحصاءات الملف ونشاطه.",
    profileVisibility: "خصوصية الملف الشخصي", profileVisibilityHelp: "يؤثر هذا الإعداد على النسخة المحلية فقط",
    aboutHelp: "تظهر في ملفك الشخصي", aboutPlaceholder: "اكتب نبذة عنك",
    likeProfile: "أعجبني الملف", likedProfile: "أعجبني", moreActions: "المزيد من الخيارات",
    viewProfile: "عرض الملف الشخصي", publicProfile: "ملف عام", privateProfileNotice: "هذا الملف خاص.",
    profileViewed: "تمت مشاهدة الملف", followerCount: "متابع", friendCount: "صديق", photoCount: "صور",
    demoProfileBio: "عضو في BlackMessage", profileOf: "ملف {name}", cannotAccessPrivate: "هذا الملف خاص.",
    friendMenuLabel: "المزيد من الخيارات لـ {name}",
    global: "عام", private: "خاص", following: "تتابعه", follow: "متابعة",
    liked: "أعجبني", like: "إعجاب", profileUnavailable: "هذا الملف غير متاح.",
    ownProfile: "ملفك الشخصي", profileActionFollow: "متابعة", profileActionLike: "أعجبني الملف",
    createGroup: "＋ إنشاء مجموعة", openBot: "✦ فتح روبوت BlackMessage", posts: "المنشورات",
    postsPrivateNote: "تُحفظ المنشورات العامة في هذه النسخة المحلية ولا تُنشر على الإنترنت.", createPost: "＋ إنشاء منشور",
    postCaption: "اكتب وصفًا", publishPost: "نشر", postSaved: "تم نشر المنشور.",
    postGlobalOnly: "اجعل ملفك عامًا لنشر المنشورات.", noPosts: "لا توجد منشورات بعد.",
    removePost: "حذف المنشور", hideProfile: "إخفاء ملفي عن هذا الصديق",
    showProfileToFriend: "إظهار ملفي لهذا الصديق", groupDemoNotice: "أنشئ محادثة جماعية. تظهر أسماء الأعضاء.",
    hideFriendProfile: "إخفاء ملف هذا الصديق", showFriendProfile: "إظهار ملف هذا الصديق",
    editProfile: "تعديل الملف الشخصي", profileHidden: "اختار هذا الصديق عدم إظهار هذا الملف.",
    groupExists: "توجد محادثة بهذا الاسم بالفعل.",
    groupName: "اسم المجموعة", groupNamePlaceholder: "مثال: فريق المشروع",
    groupMembers: "الأعضاء (افصل الأسماء بفواصل)", groupMembersPlaceholder: "أليكس، سام",
    botChatName: "روبوت BlackMessage", botWelcome: "مرحبًا! أنا روبوت BlackMessage. عمّ تريد أن نتحدث؟",
    postTooLarge: "يجب ألا يتجاوز حجم كل ملف 5 ميغابايت.", postMediaOnly: "اختر صورًا أو مقاطع فيديو.",
    memberLabel: "الأعضاء", botReply: "شكرًا على رسالتك!",
    originalQualityNote: "لا يتم ضغط الملفات. يمكن اختيار ملف بحجم 500 ميغابايت، لكن حفظه يعتمد على مساحة المتصفح؛ وتبقى الملفات على هذا الجهاز.",
    attachFiles: "إرفاق ملفات", uploadFailed: "تعذّر حفظ الملفات في مساحة المتصفح.", uploadFilesLabel: "جارٍ رفع الملفات…",
    downloadFile: "تنزيل", fileSize: "{size} ميغابايت", messageActions: "إجراءات الرسالة",
    playVoiceMessage: "تشغيل الرسالة الصوتية", pauseVoiceMessage: "إيقاف الرسالة الصوتية مؤقتًا",
    voiceMessagePlaybackFailed: "تعذّر تشغيل هذه الرسالة الصوتية.",
    voiceRecordingRequestingMic: "اسمح باستخدام الميكروفون من المتصفح لبدء التسجيل.",
    voiceRecordingActive: "جارٍ التسجيل… تحدث الآن.",
    voiceRecordingPaused: "تم إيقاف التسجيل مؤقتًا.",
    voiceRecordingReady: "التسجيل جاهز. استمع إليه ثم أرسله أو احذفه.",
    voiceRecordingSending: "جارٍ إرسال الرسالة الصوتية…",
    voiceRecordingSent: "تم إرسال الرسالة الصوتية.",
    voiceRecordingDiscarded: "تم حذف التسجيل الصوتي.",
    viewMedia: "عرض الوسائط", replyMessage: "رد", replyingTo: "ردًا على",
    editMessage: "تعديل الرسالة", editMessageTitle: "تعديل رسالتك", editedMessageEmpty: "لا يمكن أن تكون الرسالة فارغة.",
    pinMessage: "تثبيت", unpinMessage: "إلغاء التثبيت", pinnedMessage: "رسالة مثبتة",
    blurImage: "تمويه الصورة", unblurImage: "إزالة تمويه الصورة", deleteMessage: "حذف الرسالة",
    filterMessages: "تصفية الرسائل", filterPlaceholder: "تصفية هذه المحادثة",
    copyMessage: "نسخ الرسالة", messageCopyFailed: "تعذّر نسخ الرسالة. تحقق من صلاحيات الحافظة.",
    noMatchingMessages: "لا توجد رسائل تطابق عامل التصفية.", clearMessageFilter: "مسح عامل التصفية",
    username: "اسم المستخدم", joinedOn: "تاريخ الانضمام: {date}", developerBadge: "مُبرمجة هذا التطبيق",
    addFriend: "＋ إضافة صديق",
    friendName: "اسم الصديق", friendNamePlaceholder: "أدخل الاسم", friendExists: "يوجد صديق بهذا الاسم بالفعل.",
    followedNotice: "أصبحت تتابع {name}.", followerNotification: "بدأ {name} بمتابعة ملفك الشخصي.",
    blockedNotice: "لقد حظرت {name}.",
    newFriendNotice: "تمت إضافة {name} إلى أصدقائك.",
    renameVerificationNote: "يتطلب تغيير اسمك إعادة التحقق من عنوان البريد الإلكتروني نفسه.",
    verificationForName: "لتغيير اسمك، تحقق من عنوان البريد الإلكتروني نفسه مرة أخرى: {email}",
    duplicateDisplayName: "اسم العرض هذا مستخدم بالفعل من حساب آخر.",
    nameChanged: "تم تحديث اسم العرض بعد التحقق من البريد الإلكتروني.",
    invalidDisplayName: "أدخل اسم عرض يتكون من 2 إلى 32 حرفًا.",
    simulateFollower: "عرض إشعار متابع جديد", newFollowerName: "متابع جديد",
    newFollowerNotice: "بدأ متابع جديد بمتابعة ملفك الشخصي."
  }
};

const extensionByLanguage = { javascript: "js", python: "py", csharp: "cs", html: "html", css: "css" };
let language = localStorage.getItem("bluebird-language") || "en";
let accountMode = "signin";
let activeChat = 0;
let currentFolderId = null;
let currentAccount = null;
let mobileAppLocked = false;
let pendingVerification = null;
let pendingProfileImage = null;
let contactActionsIndex = null;
let accountActionsEmail = null;
let accountOperationInProgress = false;
let attachmentUploadInProgress = false;
let pinFlowMode = "unlock";
let pinFlowAccount = null;
let pinRecoveryCode = null;
let viewedProfile = { own: true, chatIndex: null };
let profilePageReturnMode = "chat";
let toastTimer;
let database;
let audioContext;
let previewUrls = [];
let pendingPostFiles = [];
let profileMediaUrls = [];
let messageMediaUrls = [];
let selectedMessage = null;
let pendingReply = null;
let viewerMediaUrl = null;

function text(key) {
  return translations[language][key] || translations.en[key] || key;
}

function applyLanguage(nextLanguage) {
  language = translations[nextLanguage] ? nextLanguage : "en";
  localStorage.setItem("bluebird-language", language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach(element => {
    element.textContent = text(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
    element.placeholder = text(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll(".language-choice").forEach(button => {
    const active = button.dataset.language === language;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("search").setAttribute("aria-label", text("search"));
  updateLockButton();
  $("codeBtn").title = $("codeBtn").ariaLabel = text("openCode");
  $("settingsBtn").title = $("settingsBtn").ariaLabel = text("settings");
  $("themeBtn").title = $("themeBtn").ariaLabel = text("toggleTheme");
  $("mobileMenuToggle").title = $("mobileMenuToggle").ariaLabel =
    text(document.body.classList.contains("mobile-menu-open") ? "closeMobileMenu" : "mobileMenu");
  $("mobileMenuBackdrop").setAttribute("aria-label", text("closeMobileMenu"));
  $("contactActionsBtn").title = $("contactActionsBtn").ariaLabel = text("friendOptions");
  $("toggleMessageFilter").title = $("toggleMessageFilter").ariaLabel = text("filterMessages");
  $("attachFilesBtn").title = $("attachFilesBtn").ariaLabel = text("attachFiles");
  $("closeToast").setAttribute("aria-label", text("dismiss"));
  $("profileMenuBtn").setAttribute("aria-label", text("profileMenu"));
  $("myMessageColor").setAttribute("aria-label", text("myMessageColor"));
  $("friendMessageColor").setAttribute("aria-label", text("friendMessageColor"));
  $("profilePrivacy").setAttribute("aria-label", text("profilePrivacy"));
  $("profilePrivacyMenu").setAttribute("aria-label", text("profilePrivacy"));
  $("messageFilterInput").setAttribute("aria-label", text("filterMessages"));
  updateFriendRequestTabCount();
  $("clearMessageFilter").setAttribute("aria-label", text("clearMessageFilter"));
  $("authSubmit").textContent = text(accountMode === "signin" ? "signIn" : "createAccount");
  $("signInMode").classList.toggle("active", accountMode === "signin");
  $("signUpMode").classList.toggle("active", accountMode === "signup");
  renderChats($("search").value);
  if (database) renderFolders();
}

function initials(name) {
  return name.split(/\s+/).map(part => part[0] || "").join("").slice(0, 2).toUpperCase();
}

function renderChats(filter = "") {
  const list = $("chatList");
  if (!list) return;
  list.replaceChildren();
  const state = readContactState();
  chats.forEach((chat, index) => {
    if (chat.isAccountPreview) return;
    if (state[chat.name]?.deleted) return;
    if (!chat.name.toLowerCase().includes(filter.toLowerCase())) return;
    const row = document.createElement("div");
    row.className = "chat-item-row";
    const button = document.createElement("button");
    button.type = "button";
    const chatBlocked = Boolean(state[chat.name]?.blocked || (chat.accountEmail && state.accountBlocks?.[chat.accountEmail]));
    button.className = `chat-item${index === activeChat ? " active" : ""}${chatBlocked ? " blocked" : ""}`;
    button.innerHTML = `<span class="avatar ${chat.color}"></span>
      <span class="chat-copy"><span class="chat-title"></span><span class="chat-preview"></span></span>`;
    button.querySelector(".avatar").textContent = initials(chat.name);
    button.querySelector(".chat-title").textContent = chat.name;
    button.querySelector(".chat-preview").textContent = chat.preview;
    button.addEventListener("click", () => openChat(index));
    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "chat-more icon-btn";
    menuButton.textContent = "⋮";
    menuButton.title = text("friendMenuLabel").replace("{name}", chat.name);
    menuButton.setAttribute("aria-label", menuButton.title);
    menuButton.addEventListener("click", () => {
      activeChat = index;
      openChat(index);
      if (chat.accountEmail) openAccountActions(chat.accountEmail);
      else openContactActions();
    });
    menuButton.hidden = Boolean(chat.isBot || chat.isGroup);
    row.append(button, menuButton);
    list.append(row);
  });
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = text("noChats");
    list.append(empty);
  }
  renderAccountSearchResults(filter);
}

function renderAccountSearchResults(filter, results = $("accountSearchResults"), includeAll = false) {
  const section = results === $("accountSearchResults") ? $("accountSearchSection") : null;
  results.replaceChildren();
  const query = filter.trim().toLocaleLowerCase();
  if (section) section.hidden = !query;
  if (!query && !includeAll) return;
  const matches = accountList().filter(account =>
    (includeAll || account.email !== currentAccount?.email) &&
    `${account.name || ""} ${account.username || ""} ${account.email || ""}`.toLocaleLowerCase().includes(query)
  );
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? text("noLocalAccounts") : text("noOtherAccounts");
    results.append(empty);
    return;
  }
  matches.forEach(account => {
    const isCurrentAccount = account.email === currentAccount?.email;
    const row = document.createElement("div");
    row.className = "account-search-row";
    const profileButton = document.createElement("button");
    profileButton.type = "button";
    profileButton.className = "account-search-profile";
    const avatar = document.createElement("span");
    avatar.className = "avatar purple";
    const avatarImage = document.createElement("img");
    avatarImage.className = "avatar-image";
    avatarImage.alt = "";
    avatarImage.hidden = !account.profileImage;
    avatarImage.src = account.profileImage || "";
    const avatarInitials = document.createElement("span");
    avatarInitials.textContent = initials(account.name || account.username || account.email);
    avatarImage.addEventListener("error", () => { avatarImage.hidden = true; });
    avatar.append(avatarImage, avatarInitials);
    const details = document.createElement("span");
    details.className = "chat-copy";
    const name = document.createElement("strong");
    name.textContent = account.name || account.username;
    const username = document.createElement("small");
    username.textContent = `@${account.username || account.email.split("@")[0]}`;
    const visibility = document.createElement("small");
    const isGlobal = account.preferences?.privacy === "global";
    visibility.className = `account-visibility ${isGlobal ? "is-global" : "is-private"}`;
    visibility.textContent = text(isGlobal ? "accountGlobal" : "accountPrivate");
    details.append(name, username, visibility);
    profileButton.append(avatar, details);
    profileButton.addEventListener("click", () => {
      if (isCurrentAccount) openProfile(true, null, "friends", false);
      else openAccountProfile(account.email);
    });
    if (isCurrentAccount) {
      const ownerLabel = document.createElement("small");
      ownerLabel.className = "account-visibility is-global";
      ownerLabel.textContent = text("ownAccountProfile");
      details.append(ownerLabel);
    }
    const isFriend = !isCurrentAccount && isAccountFriend(account.email);
    const requestState = !isCurrentAccount && accountFriendRequestState(account.email);
    const friendButton = document.createElement("button");
    friendButton.type = "button";
    friendButton.className = "secondary account-friend-button";
    friendButton.hidden = isCurrentAccount;
    friendButton.textContent = text(isFriend ? "removeFriend" : requestState.received ? "acceptRequest" : requestState.sent ? "requestSent" : "addFriend").replace(/^＋\s*/, "");
    friendButton.disabled = requestState.sent || requestState.blocked;
    friendButton.addEventListener("click", () => {
      if (isFriend) removeAccountFriend(account.email);
      else if (requestState.received) acceptFriendRequest(account.email);
      else sendFriendRequest(account.email);
    });
    const isBlocked = Boolean(readContactState().accountBlocks?.[account.email]);
    const blockButton = document.createElement("button");
    blockButton.type = "button";
    blockButton.className = `danger-button account-block-button${isBlocked ? " is-blocked" : ""}`;
    blockButton.hidden = isCurrentAccount;
    blockButton.textContent = text(isBlocked ? "unblockFriend" : "blockFriend");
    blockButton.addEventListener("click", () => {
      toggleAccountBlock(account.email);
      if (!$("friendsView").hidden) {
        renderAccountSearchResults($("friendSearchInput").value, $("friendSearchResults"), true);
      }
    });
    const actions = document.createElement("button");
    actions.type = "button";
    actions.className = "account-search-more icon-btn";
    actions.hidden = isCurrentAccount;
    actions.textContent = "⋮";
    actions.title = text("accountMenu").replace("{name}", account.name || account.username);
    actions.setAttribute("aria-label", actions.title);
    actions.addEventListener("click", () => openAccountActions(account.email));
    row.append(profileButton, friendButton, blockButton, actions);
    results.append(row);
  });
}

function renderFriendSearchResults() {
  const results = $("friendSearchResults");
  const query = $("friendSearchInput").value.trim().toLocaleLowerCase();
  const kind = document.querySelector(".friend-search-tab.active")?.dataset.friendKind || "people";
  if (kind === "people") {
    renderAccountSearchResults(query, results, true);
    return;
  }
  results.replaceChildren();
  if (kind === "groups") {
    const groups = chats.map((chat, index) => ({ chat, index }))
      .filter(({ chat }) => chat.isGroup && `${chat.name} ${(chat.members || []).join(" ")}`.toLocaleLowerCase().includes(query));
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = text("noGroupsFound");
      results.append(empty);
      return;
    }
    groups.forEach(({ chat, index }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "friend-search-result";
      const avatar = document.createElement("span");
      avatar.className = `avatar ${chat.color || "purple"}`;
      avatar.textContent = initials(chat.name);
      const details = document.createElement("span");
      details.className = "friend-search-result-copy";
      const name = document.createElement("strong");
      name.textContent = chat.name;
      const members = document.createElement("small");
      members.textContent = `${text("memberLabel")}: ${(chat.members || []).join(", ")}`;
      details.append(name, members);
      button.append(avatar, details);
      button.addEventListener("click", () => {
        $("friendsView").hidden = true;
        $("app").classList.remove("friends-mode");
        openChat(index);
      });
      results.append(button);
    });
    return;
  }
  const botName = text("botChatName");
  if (!`${botName} BlackMessage bot`.toLocaleLowerCase().includes(query)) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = text("noBotsFound");
    results.append(empty);
    return;
  }
  const botButton = document.createElement("button");
  botButton.type = "button";
  botButton.className = "friend-search-result";
  const botAvatar = document.createElement("span");
  botAvatar.className = "avatar gold";
  botAvatar.textContent = "✦";
  const botDetails = document.createElement("span");
  botDetails.className = "friend-search-result-copy";
  const botTitle = document.createElement("strong");
  botTitle.textContent = botName;
  const botDescription = document.createElement("small");
  botDescription.textContent = text("botWelcome");
  botDetails.append(botTitle, botDescription);
  botButton.append(botAvatar, botDetails);
  botButton.addEventListener("click", () => {
    $("friendsView").hidden = true;
    $("app").classList.remove("friends-mode");
    openBotChat();
  });
  results.append(botButton);
}

function accountFriendRequestState(email) {
  const accounts = accountList();
  const target = accounts.find(account => account.email === email);
  const ownState = readContactState();
  const otherState = JSON.parse(localStorage.getItem(`bluebird-contacts-${encodeURIComponent(email)}`) || "{}");
  return {
    sent: Boolean(target?.friendRequests?.some(request => request.fromEmail === currentAccount?.email)),
    received: Boolean(currentAccount?.friendRequests?.some(request => request.fromEmail === email)),
    blocked: Boolean(ownState.accountBlocks?.[email] || otherState.accountBlocks?.[currentAccount?.email])
  };
}

function renderFriendCenter(section = "requests") {
  document.querySelectorAll(".friend-center-tab").forEach(button => {
    const active = button.dataset.friendSection === section;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("friendSearchPanel").hidden = section !== "search";
  $("friendRequestsPanel").hidden = section !== "requests";
  $("blockedFriendsPanel").hidden = section !== "blocked";
  const titleKey = section === "search" ? "findFriendsTitle" : section === "requests" ? "friendRequests" : "blockedFriends";
  const descriptionKey = section === "search" ? "accountSearchNote" : section === "requests" ? "friendRequestsDescription" : "blockedFriendsDescription";
  $("friendCenterTitle").textContent = text(titleKey);
  $("friendCenterDescription").textContent = text(descriptionKey);
  updateFriendRequestTabCount();

  if (section === "requests") {
    const panel = $("friendRequestsPanel");
    panel.replaceChildren();
    const requests = (currentAccount?.friendRequests || [])
      .filter(request => request && typeof request.fromEmail === "string")
      .map(request => ({ request, account: accountList().find(account => account.email === request.fromEmail) }))
      .filter(({ request, account }) => account && !readContactState().accountBlocks?.[request.fromEmail]);
    if (!requests.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = text("noFriendRequests");
      panel.append(empty);
      return;
    }
    requests.forEach(({ request, account }) => {
      const row = createManagedFriendRow(account);
      const details = row.querySelector(".chat-copy");
      const description = document.createElement("small");
      description.textContent = text("requestReceived").replace("{name}", account.name);
      details.append(description);
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "friend-request-action friend-request-accept";
      accept.textContent = text("acceptRequest");
      accept.addEventListener("click", () => acceptFriendRequest(request.fromEmail));
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "friend-request-action friend-request-decline";
      reject.textContent = text("rejectRequest");
      reject.addEventListener("click", () => rejectFriendRequest(request.fromEmail));
      const block = document.createElement("button");
      block.type = "button";
      block.className = "friend-request-action friend-request-block";
      block.textContent = text("blockFriend");
      block.addEventListener("click", () => toggleAccountBlock(request.fromEmail));
      row.append(accept, reject, block);
      panel.append(row);
    });
    return;
  }

  if (section === "blocked") {
    const panel = $("blockedFriendsPanel");
    panel.replaceChildren();
    const blockedEmails = Object.entries(readContactState().accountBlocks || {})
      .filter(([, blocked]) => blocked)
      .map(([email]) => email);
    const blockedAccounts = blockedEmails.map(email => accountList().find(account => account.email === email)).filter(Boolean);
    if (!blockedAccounts.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = text("noBlockedFriends");
      panel.append(empty);
      return;
    }
    blockedAccounts.forEach(account => {
      const row = createManagedFriendRow(account);
      const unblock = document.createElement("button");
      unblock.type = "button";
      unblock.className = "secondary friend-request-action";
      unblock.textContent = text("unblockFriend");
      unblock.addEventListener("click", () => toggleAccountBlock(account.email));
      row.append(unblock);
      panel.append(row);
    });
  }
}

function stopNearbyFriendCamera() {
  if (nearbyScanFrame) cancelAnimationFrame(nearbyScanFrame);
  nearbyScanFrame = 0;
  nearbyCameraStream?.getTracks().forEach(track => track.stop());
  nearbyCameraStream = null;
  const video = $("nearbyFriendCamera");
  if (video) {
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  }
}

function showNearbyFriendStatus(message, isError = false) {
  const status = $("nearbyFriendStatus");
  status.textContent = message;
  status.dataset.error = String(isError);
  status.hidden = false;
}

function openNearbyFriendDialog() {
  $("nearbyFriendError").hidden = true;
  $("nearbyFriendStatus").hidden = true;
  $("nearbyFriendCodeInput").value = "";
  $("nearbyScannedCard").hidden = true;
  const username = currentAccount.username || "";
  const prefix = `BM2|${currentAccount.friendQrId}|${username}|`;
  const maxNameBytes = 106 - new TextEncoder().encode(prefix).length;
  let name = "";
  for (const character of String(currentAccount.name || "").replace(/[|\u0000-\u001f]/g, " ").trim()) {
    if (new TextEncoder().encode(name + character).length > maxNameBytes) break;
    name += character;
  }
  const code = `${prefix}${name}`;
  $("nearbyFriendCode").value = code;
  $("nearbyOwnName").textContent = currentAccount.name || username;
  $("nearbyOwnUsername").textContent = `@${username}`;
  $("nearbyOwnAvatar").textContent = initials(currentAccount.name || username);
  $("nearbyOwnPhoto").hidden = !currentAccount.profileImage;
  $("nearbyOwnAvatar").hidden = Boolean(currentAccount.profileImage);
  $("nearbyOwnPhoto").src = currentAccount.profileImage || "";
  try {
    window.drawFriendQr($("nearbyFriendQr"), code);
  } catch (error) {
    $("nearbyFriendError").textContent = error.message || text("invalidFriendQr");
    $("nearbyFriendError").hidden = false;
    console.error("Could not create the friend QR code.", error);
  }
  $("nearbyFriendDialog").showModal();
}

function parseNearbyFriendCode(value) {
  const parts = value.trim().split("|");
  if (parts.length < 3) return null;
  if (parts[0] === "BM2") {
    const id = parts[1].trim().toLowerCase();
    const hasUsername = parts.length === 4;
    const username = hasUsername ? parts[2].trim().toLowerCase() : `qr_${id}`;
    const name = parts[hasUsername ? 3 : 2].replace(/[\u0000-\u001f]/g, "").trim().slice(0, 48);
    if (!/^[a-z0-9_]{1,24}$/.test(username)) return null;
    if (!/^[a-f0-9]{32}$/.test(id) || !name) return null;
    return { id, username, name };
  }
  if (parts.length !== 3) return null;
  const name = parts[2].replace(/[\u0000-\u001f]/g, "").trim().slice(0, 48);
  if (parts[0] !== "BM1") return null;
  const username = parts[1].trim().toLowerCase();
  if (!/^[a-z0-9_]{1,24}$/.test(username) || !name) return null;
  return { id: null, username, name };
}

function showNearbyFriendPreview(value) {
  const friend = parseNearbyFriendCode(value);
  const card = $("nearbyScannedCard");
  if (!friend || friend.id === currentAccount.friendQrId ||
    (friend.id === null && friend.username === currentAccount.username?.toLowerCase())) {
    card.hidden = true;
    return;
  }
  const localAccount = friend.id && accountList().find(account => account.friendQrId === friend.id);
  const photo = localAccount?.profileImage || null;
  const name = localAccount?.name || friend.name;
  $("nearbyScannedName").textContent = name;
  $("nearbyScannedUsername").textContent = `@${localAccount?.username || friend.username}`;
  $("nearbyScannedAvatar").textContent = initials(name);
  $("nearbyScannedAvatar").hidden = Boolean(photo);
  $("nearbyScannedPhoto").hidden = !photo;
  $("nearbyScannedPhoto").src = photo || "";
  $("nearbyScannedStatus").hidden = true;
  const isBlocked = Boolean(friend.id && readContactState().blockedQrIds?.[friend.id]);
  $("acceptNearbyFriendBtn").hidden = isBlocked;
  $("blockNearbyFriendBtn").textContent = text(isBlocked ? "unblockFriend" : "blockFriend");
  $("nearbyScannedCard").dataset.friendCode = value.trim();
  card.hidden = false;
}

function addNearbyFriend(value) {
  const friend = parseNearbyFriendCode(value);
  if (!friend || friend.id === currentAccount.friendQrId ||
    (friend.id === null && friend.username === currentAccount.username?.toLowerCase())) {
    $("nearbyFriendError").textContent = text("invalidFriendQr");
    $("nearbyFriendError").hidden = false;
    return;
  }
  const exists = chats.some(chat =>
    (friend.id && chat.friendQrId === friend.id) ||
    (!friend.id && chat.username?.toLowerCase() === friend.username) ||
    (chat.accountEmail && accountList().find(account => account.email === chat.accountEmail)?.username?.toLowerCase() === friend.username)
  );
  if (exists) {
    $("nearbyFriendError").textContent = text("friendExists");
    $("nearbyFriendError").hidden = false;
    return;
  }
  if (friend.id && readContactState().blockedQrIds?.[friend.id]) {
    $("nearbyFriendError").textContent = text("nearbyFriendBlocked").replace("{name}", friend.name);
    $("nearbyFriendError").hidden = false;
    return;
  }
  chats.unshift({
    name: friend.name,
    username: friend.username,
    friendQrId: friend.id,
    profileImage: accountList().find(account => account.friendQrId === friend.id)?.profileImage || null,
    isLocalFriend: true,
    color: "purple",
    messages: [],
    preview: ""
  });
  saveChats();
  renderChats($("search").value);
  $("nearbyFriendError").hidden = true;
  stopNearbyFriendCamera();
  $("nearbyFriendDialog").close();
  showContactToast(friend.name, "purple", text("friendQrAdded").replace("{name}", friend.name));
}

function toggleNearbyFriendBlock() {
  const code = $("nearbyScannedCard").dataset.friendCode;
  const friend = parseNearbyFriendCode(code || "");
  if (!friend?.id) {
    $("nearbyFriendError").textContent = text("invalidFriendQr");
    $("nearbyFriendError").hidden = false;
    return;
  }
  try {
    const state = readContactState();
    state.blockedQrIds = state.blockedQrIds || {};
    if (state.blockedQrIds[friend.id]) delete state.blockedQrIds[friend.id];
    else state.blockedQrIds[friend.id] = { name: friend.name, username: friend.username };
    writeContactState(state);
    showNearbyFriendPreview(code);
    $("nearbyScannedStatus").textContent = text(state.blockedQrIds[friend.id] ? "nearbyFriendBlocked" : "nearbyFriendUnblocked")
      .replace("{name}", friend.name);
    $("nearbyScannedStatus").hidden = false;
  } catch (error) {
    $("nearbyFriendError").textContent = `${text("storageError")} ${error.message || ""}`;
    $("nearbyFriendError").hidden = false;
    console.error("Could not save the nearby friend block state.", error);
  }
}

async function scanNearbyFriendImage(file) {
  if (!file) return;
  if (typeof BarcodeDetector === "undefined") {
    showNearbyFriendStatus(text("qrCameraUnavailable"));
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    if (typeof createImageBitmap !== "function") {
      showNearbyFriendStatus(text("qrCameraUnavailable"));
      return;
    }
    const image = await createImageBitmap(file);
    let codes;
    try {
      codes = await detector.detect(image);
    } finally {
      image.close();
    }
    if (!codes.length) {
      showNearbyFriendStatus(text("invalidFriendQr"), true);
      return;
    }
    $("nearbyFriendCodeInput").value = codes[0].rawValue;
    $("nearbyFriendError").hidden = true;
    showNearbyFriendPreview(codes[0].rawValue);
    $("nearbyScannedCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    showNearbyFriendStatus(`${text("qrCameraUnavailable")} ${error.message || ""}`, true);
    console.error("Could not scan the selected friend QR image.", error);
  }
}

async function startNearbyFriendCamera() {
  stopNearbyFriendCamera();
  if (window.isSecureContext === false || typeof BarcodeDetector === "undefined" ||
    !navigator.mediaDevices?.getUserMedia) {
    showNearbyFriendStatus(text("qrCameraUnavailable"));
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    nearbyCameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } }
    });
    const video = $("nearbyFriendCamera");
    video.srcObject = nearbyCameraStream;
    video.hidden = false;
    await video.play();
    $("nearbyFriendStatus").hidden = true;
    const scan = async () => {
      if (!nearbyCameraStream || video.hidden) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          $("nearbyFriendCodeInput").value = codes[0].rawValue;
          $("nearbyFriendError").hidden = true;
          showNearbyFriendPreview(codes[0].rawValue);
          $("nearbyScannedCard").scrollIntoView({ block: "nearest", behavior: "smooth" });
          stopNearbyFriendCamera();
          return;
        }
      } catch (error) {
        stopNearbyFriendCamera();
        showNearbyFriendStatus(`${text("friendQrCameraError")} ${error.message || ""}`, true);
        console.error("Could not read the nearby friend QR code.", error);
        return;
      }
      nearbyScanFrame = requestAnimationFrame(scan);
    };
    nearbyScanFrame = requestAnimationFrame(scan);
  } catch (error) {
    stopNearbyFriendCamera();
    showNearbyFriendStatus(`${text("friendQrCameraError")} ${error.message || ""}`, true);
    console.error("Could not start the friend QR camera.", error);
  }
}

function updateFriendRequestTabCount() {
  const count = String(currentAccount?.friendRequests?.length || 0);
  const tab = $("friendRequestsTab");
  if (tab) {
    tab.textContent = text("friendRequestsCount")
      .replace("{count}", count);
  }
  const button = $("friendCenterBtn");
  if (button) button.textContent = text("friendCenterCount").replace("{count}", count);
}

function openFriendsCenter(section) {
  closeMobileMenu();
  $("profilePage").hidden = true;
  $("filesView").hidden = true;
  $("codeStudio").hidden = true;
  $("friendsView").hidden = false;
  $("app").classList.remove("profile-mode", "files-mode", "code-mode");
  $("app").classList.add("friends-mode");
  document.body.classList.remove("chat-open");
  renderFriendCenter(section);
  if (section === "search") {
    $("friendSearchInput").value = "";
    renderFriendSearchResults();
    $("friendSearchInput").focus();
  }
}

function createManagedFriendRow(account) {
  const row = document.createElement("div");
  row.className = "account-search-row friend-management-row";
  const avatar = document.createElement("span");
  avatar.className = "avatar purple";
  const image = document.createElement("img");
  image.className = "avatar-image";
  image.alt = "";
  image.hidden = !account.profileImage;
  image.src = account.profileImage || "";
  image.addEventListener("error", () => { image.hidden = true; });
  const avatarInitials = document.createElement("span");
  avatarInitials.textContent = initials(account.name || account.username || account.email);
  avatar.append(image, avatarInitials);
  const details = document.createElement("span");
  details.className = "chat-copy friend-management-copy";
  const name = document.createElement("strong");
  name.textContent = account.name || account.username;
  const username = document.createElement("small");
  username.textContent = `@${account.username || account.email.split("@")[0]}`;
  details.append(name, username);
  row.append(avatar, details);
  return row;
}

function saveAccounts(accounts) {
  localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  currentAccount = accounts.find(account => account.email === currentAccount.email) || currentAccount;
}

function sendFriendRequest(email) {
  const accounts = accountList();
  const target = accounts.find(account => account.email === email);
  if (!target || !currentAccount || email === currentAccount.email) return;
  const state = accountFriendRequestState(email);
  if (state.blocked || isAccountFriend(email)) return;
  if (state.received) {
    acceptFriendRequest(email);
    return;
  }
  if (state.sent) return;
  target.friendRequests = [...(target.friendRequests || []), {
    fromEmail: currentAccount.email,
    createdAt: new Date().toISOString()
  }];
  try {
    saveAccounts(accounts);
  } catch (error) {
    showContactToast(target.name, "purple", `${text("storageError")} ${error.message || ""}`);
    console.error("Could not save the friend request.", error);
    return;
  }
  renderAccountSearchResults($("friendSearchInput").value, $("friendSearchResults"), true);
  updateFriendRequestTabCount();
  showContactToast(target.name, "purple", text("requestSent"));
}

function ensureAccountConversation(list, account) {
  let chat = list.find(item => item.accountEmail === account.email);
  if (chat) {
    chat.name = account.name;
    chat.color = chat.color || "purple";
    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
    delete chat.isAccountPreview;
    return chat;
  }
  chat = { name: account.name, accountEmail: account.email, preview: "", color: "purple", messages: [] };
  list.unshift(chat);
  return chat;
}

function acceptFriendRequest(email) {
  const accounts = accountList();
  const sender = accounts.find(account => account.email === email);
  const receiver = accounts.find(account => account.email === currentAccount?.email);
  if (!sender || !receiver || !receiver.friendRequests?.some(request => request.fromEmail === email)) return;
  if (accountFriendRequestState(email).blocked) return;
  try {
    receiver.friendRequests = receiver.friendRequests.filter(request => request.fromEmail !== email);
    const currentChat = ensureAccountConversation(chats, sender);
    const otherStorageKey = `bluebird-chats-${encodeURIComponent(sender.email)}`;
    const otherChats = JSON.parse(localStorage.getItem(otherStorageKey) || "[]");
    if (!Array.isArray(otherChats)) throw new Error("Saved conversation data is invalid.");
    ensureAccountConversation(otherChats, receiver);
    localStorage.setItem(otherStorageKey, JSON.stringify(otherChats));
    const otherContactKey = `bluebird-contacts-${encodeURIComponent(sender.email)}`;
    const otherContactState = JSON.parse(localStorage.getItem(otherContactKey) || "{}");
    otherContactState[receiver.name] = { ...otherContactState[receiver.name], deleted: false };
    localStorage.setItem(otherContactKey, JSON.stringify(otherContactState));

    for (const account of [sender, receiver]) {
      const stats = { followers: 0, friends: 0, views: 0, likes: 0, ...(account.socialStats?.own || {}) };
      stats.friends += 1;
      account.socialStats = { ...(account.socialStats || {}), own: stats };
    }
    saveAccounts(accounts);
    const state = readContactState();
    state[currentChat.name] = { ...state[currentChat.name], deleted: false };
    writeContactState(state);
    saveChats();
    renderChats($("search").value);
    refreshFriendCenter();
    showContactToast(sender.name, "purple", text("friendAccepted").replace("{name}", sender.name));
  } catch (error) {
    showContactToast(text("friendRequests"), "purple", `${text("storageError")} ${error.message || ""}`);
    console.error("Could not accept the friend request.", error);
  }
}

function rejectFriendRequest(email) {
  const accounts = accountList();
  const receiver = accounts.find(account => account.email === currentAccount?.email);
  if (!receiver) return;
  receiver.friendRequests = (receiver.friendRequests || []).filter(request => request.fromEmail !== email);
  try {
    saveAccounts(accounts);
  } catch (error) {
    showContactToast(text("friendRequests"), "purple", `${text("storageError")} ${error.message || ""}`);
    console.error("Could not decline the friend request.", error);
    return;
  }
  refreshFriendCenter();
}

function refreshFriendCenter() {
  if ($("friendsView").hidden) return;
  const activeSection = document.querySelector(".friend-center-tab.active")?.dataset.friendSection || "requests";
  renderFriendCenter(activeSection);
  if (activeSection === "search") renderFriendSearchResults();
}

function findAccountChat(email) {
  return chats.findIndex(chat => chat.accountEmail === email && !chat.isAccountPreview);
}

function isAccountFriend(email) {
  const index = findAccountChat(email);
  return index >= 0 && !readContactState()[chats[index].name]?.deleted;
}

function openAccountProfile(email) {
  let index = findAccountChat(email);
  if (index < 0) {
    const account = accountList().find(item => item.email === email);
    if (!account) return;
    chats.push({
      name: account.name,
      accountEmail: account.email,
      preview: "",
      color: "purple",
      messages: [],
      isAccountPreview: true
    });
    index = chats.length - 1;
  }
  openProfile(false, index);
}

function openAccountActions(email) {
  const account = accountList().find(item => item.email === email);
  if (!account) return;
  accountActionsEmail = email;
  $("accountActionName").textContent = account.name;
  $("accountActionUsername").textContent = `@${account.username || account.email.split("@")[0]}`;
  $("accountActionAvatar").textContent = initials(account.name);
  const contactState = readContactState();
  const isBlocked = Boolean(contactState.accountBlocks?.[email]);
  $("blockAccountBtn").textContent = text(isBlocked ? "unblockFriend" : "blockFriend");
  $("blockAccountBtn").classList.toggle("is-blocked", !isBlocked);
  $("blockAccountBtn").classList.toggle("is-unblocked", isBlocked);
  const isFriend = isAccountFriend(email);
  const requestState = accountFriendRequestState(email);
  $("addAccountFriendBtn").hidden = isFriend;
  $("addAccountFriendBtn").disabled = requestState.sent || requestState.blocked;
  $("addAccountFriendBtn").textContent = text(requestState.received ? "acceptRequest" : requestState.sent ? "requestSent" : "addFriend");
  $("removeAccountFriendBtn").hidden = !isFriend;
  $("accountActionsDialog").showModal();
}

function addAccountFriend(email) {
  const state = accountFriendRequestState(email);
  if (state.received) acceptFriendRequest(email);
  else sendFriendRequest(email);
  $("accountActionsDialog").close();
}

function toggleAccountBlock(email) {
  const account = accountList().find(item => item.email === email);
  if (!account) return;
  const state = readContactState();
  state.accountBlocks = { ...(state.accountBlocks || {}), [email]: !state.accountBlocks?.[email] };
  writeContactState(state);
  if (state.accountBlocks[email]) {
    const accounts = accountList();
    const ownAccount = accounts.find(item => item.email === currentAccount.email);
    const blockedAccount = accounts.find(item => item.email === email);
    if (ownAccount) ownAccount.friendRequests = (ownAccount.friendRequests || []).filter(request => request.fromEmail !== email);
    if (blockedAccount) {
      blockedAccount.friendRequests = (blockedAccount.friendRequests || []).filter(request => request.fromEmail !== currentAccount.email);
    }
    saveAccounts(accounts);
  }
  $("blockAccountBtn").textContent = text(state.accountBlocks[email] ? "unblockFriend" : "blockFriend");
  $("blockAccountBtn").classList.toggle("is-blocked", !state.accountBlocks[email]);
  $("blockAccountBtn").classList.toggle("is-unblocked", state.accountBlocks[email]);
  showContactToast(account.name, "purple", text(state.accountBlocks[email] ? "blockedStatus" : "unblockedStatus").replace("{name}", account.name));
  if (state.accountBlocks[email]) $("accountActionsDialog").close();
  renderChats($("search").value);
  if (!$("friendsView").hidden) {
    const activeSection = document.querySelector(".friend-center-tab.active")?.dataset.friendSection || "requests";
    renderFriendCenter(activeSection);
    if (activeSection === "search") renderFriendSearchResults();
  }
  const index = findAccountChat(email);
  if (index >= 0 && activeChat === index) openChat(index);
}

function removeAccountFriend(email) {
  const index = findAccountChat(email);
  if (index < 0) return;
  const chat = chats[index];
  const state = readContactState();
  if (!state[chat.name]?.deleted) {
    state[chat.name] = { ...state[chat.name], deleted: true };
    writeContactState(state);
    const stats = { followers: 0, friends: 0, views: 0, likes: 0, ...(currentAccount.socialStats?.own || {}) };
    stats.friends = Math.max(0, stats.friends - 1);
    saveSocialStats({ ...socialStats(), own: stats });
  }
  saveChats();
  $("accountActionsDialog").close();
  renderChats($("search").value);
  if (!$("friendsView").hidden) {
    renderFriendSearchResults();
  }
  if (activeChat === index) refreshActiveChatAfterRemoval();
  showContactToast(chat.name, chat.color, text("removedStatus").replace("{name}", chat.name));
}

function chatsStorageKey() {
  return `bluebird-chats-${encodeURIComponent(currentAccount.email)}`;
}

function saveChats() {
  try {
    localStorage.setItem(chatsStorageKey(), JSON.stringify(chats.filter(chat => !chat.isAccountPreview)));
  } catch (error) {
    console.error("Could not save local conversations.", error);
    showContactToast(text("localAccount"), "", text("storageError"));
  }
}

function loadChats(account) {
  const saved = localStorage.getItem(`bluebird-chats-${encodeURIComponent(account.email)}`);
  chats = saved ? JSON.parse(saved) : [];
  if (!Array.isArray(chats) || chats.some(chat => typeof chat.name !== "string" || !Array.isArray(chat.messages))) {
    throw new Error("Saved local conversation data is invalid.");
  }
  chats = chats.filter(chat => !chat.isAccountPreview);
}

function socialStats() {
  return currentAccount.socialStats || {};
}

function saveSocialStats(stats) {
  currentAccount.socialStats = stats;
  const accounts = accountList();
  const accountIndex = accounts.findIndex(account => account.email === currentAccount.email);
  if (accountIndex >= 0) {
    accounts[accountIndex] = currentAccount;
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  }
}

function profileStatsKey(own, chat) {
  return own ? "own" : `friend:${chat.name}`;
}

function ensureProfileStats(own, chat) {
  if (!own && chat.accountEmail) {
    const account = accountList().find(item => item.email === chat.accountEmail);
    return account?.socialStats?.own || { followers: 0, friends: 0, views: 0, likes: 0, following: false, liked: false };
  }
  const key = profileStatsKey(own, chat);
  const stats = socialStats();
  if (stats[key]) return stats[key];
  return { followers: 0, friends: 0, views: 0, likes: 0, following: false, liked: false };
}

function setProfilePageMode(open) {
  $("profilePage").hidden = !open;
  $("app").classList.toggle("profile-mode", open);
  if (!open) return;
  $("friendsView").hidden = true;
  $("filesView").hidden = true;
  $("codeStudio").hidden = true;
  $("app").classList.remove("files-mode", "code-mode", "friends-mode");
  document.body.classList.remove("chat-open");
}

function openProfile(own, chatIndex = null, returnMode = "chat", countView = true) {
  const chat = own ? null : chats[chatIndex];
  if (!own && (!chat || readContactState()[chat.name]?.deleted)) return;
  const friendProfileHidden = !own && Boolean(readContactState()[chat.name]?.profileHidden);
  viewedProfile = { own, chatIndex };
  profilePageReturnMode = returnMode;
  const profile = own ? currentAccount : chat?.accountEmail
    ? accountList().find(item => item.email === chat.accountEmail) || null
    : null;
  const key = profileStatsKey(own, chat);
  const stats = ensureProfileStats(own, chat);
  if (countView && !own) {
    stats.views += 1;
    if (!own && chat.accountEmail && profile) saveRegisteredAccountStats(profile, stats);
    else saveSocialStats({ ...socialStats(), [key]: stats });
  }
  const name = own || profile ? profile.name : chat.name;
  const image = own || profile ? profile?.profileImage : null;
  $("publicProfileName").textContent = name;
  $("publicProfileSubtitle").textContent = own
    ? text("ownProfile")
    : text("profileOf").replace("{name}", name);
  $("developerBadge").hidden = !own;
  if (own || profile) {
    const joinedDate = new Intl.DateTimeFormat(language, { dateStyle: "medium" })
      .format(new Date(profile.createdAt));
    $("profileAccountMeta").textContent = `${text("username")}: @${profile.username} · ${text("joinedOn").replace("{date}", joinedDate)}`;
  } else {
    $("profileAccountMeta").textContent = "";
  }
  const privateProfile = !own && (friendProfileHidden || (profile && profile.preferences?.privacy !== "global"));
  const visibility = own || profile
    ? (profile?.preferences?.privacy === "global" ? "global" : "private")
    : (privateProfile ? "private" : "global");
  $("profileVisibilityBadge").textContent = text(visibility);
  $("profileVisibilityBadge").classList.toggle("is-global", visibility === "global");
  $("profileVisibilityBadge").classList.toggle("is-private", visibility !== "global");
  $("profileAboutText").textContent = own || profile
    ? (privateProfile ? text("profileHidden") : (profile?.about || text("demoProfileBio")))
    : friendProfileHidden ? text("profileHidden") : text("demoProfileBio");
  const imageElement = $("publicProfileImage");
  imageElement.hidden = !image;
  imageElement.src = image || "";
  imageElement.alt = image ? name : "";
  $("publicProfilePlaceholder").hidden = Boolean(image);
  $("publicProfilePlaceholder").textContent = initials(name);
  $("profileFollowersCount").textContent = stats.followers;
  $("profileFriendsCount").textContent = stats.friends;
  $("profileViewsCount").textContent = stats.views;
  $("profileLikesCount").textContent = stats.likes;
  $("profileGallery").replaceChildren();
  if (image && (own || profile) && !privateProfile) {
    const photo = document.createElement("img");
    photo.src = image;
    photo.alt = name;
    $("profileGallery").append(photo);
  }
  $("followProfileBtn").hidden = own || privateProfile || chat?.isGroup || chat?.isBot;
  const relation = chat?.accountEmail ? socialStats()[`user:${chat.accountEmail}`] || {} : stats;
  $("followProfileBtn").textContent = text(relation.following ? "following" : "follow");
  $("likeProfileBtn").hidden = own || privateProfile || chat?.isGroup || chat?.isBot;
  $("likeProfileBtn").textContent = text(relation.liked ? "liked" : "like");
  $("profileMoreBtn").hidden = own || chat?.accountEmail || chat?.isGroup || chat?.isBot;
  $("simulateFollowerBtn").hidden = !own;
  $("editProfilePageBtn").hidden = !own;
  $("profileMembers").hidden = !chat?.isGroup;
  $("profileMembers").textContent = chat?.isGroup
    ? `${text("memberLabel")}: ${(chat.members || []).join(", ")}`
    : "";
  $("profileStats").hidden = privateProfile;
  $("profileGallerySection").hidden = privateProfile;
  $("profileAbout").value = own ? profile?.about || "" : "";
  $("newPostLabel").hidden = !own || profile.preferences?.privacy !== "global";
  $("profilePostComposer").hidden = !own || profile.preferences?.privacy !== "global";
  $("postsVisibilityNote").textContent = own && profile.preferences?.privacy !== "global"
    ? text("postGlobalOnly")
    : (own ? text("postsPrivateNote") : (privateProfile ? text("profileHidden") : text("postsPrivateNote")));
  $("postError").hidden = true;
  renderProfilePosts(own && profile.preferences?.privacy === "global");
  setProfilePageMode(true);
}

function saveRegisteredAccountStats(account, stats) {
  const accounts = accountList();
  const index = accounts.findIndex(item => item.email === account.email);
  if (index < 0) return;
  accounts[index] = {
    ...accounts[index],
    socialStats: {
      ...(accounts[index].socialStats || {}),
      own: { ...stats }
    }
  };
  localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
}

function updateViewedProfileStat(field, toggle = false) {
  const { own, chatIndex } = viewedProfile;
  const chat = own ? null : chats[chatIndex];
  const key = profileStatsKey(own, chat);
  if (!own && chat?.accountEmail) {
    updateRegisteredProfileStat(chat, field, toggle);
    openProfile(false, chatIndex, profilePageReturnMode, false);
    return;
  }
  const stats = ensureProfileStats(own, chat);
  if (toggle) {
    stats[field] = !stats[field];
    stats[field === "following" ? "followers" : "likes"] += stats[field] ? 1 : -1;
  } else {
    stats[field] += 1;
  }
  saveSocialStats({ ...socialStats(), [key]: stats });
  openProfile(own, chatIndex, profilePageReturnMode, false);
}

function updateRegisteredProfileStat(chat, field, toggle) {
  const accounts = accountList();
  const targetIndex = accounts.findIndex(account => account.email === chat.accountEmail);
  if (targetIndex < 0) return;
  const target = accounts[targetIndex];
  const targetStats = { followers: 0, friends: 0, views: 0, likes: 0, ...(target.socialStats?.own || {}) };
  const relations = { ...socialStats() };
  const relationKey = `user:${target.email}`;
  const relation = { following: false, liked: false, ...(relations[relationKey] || {}) };
  if (toggle) {
    relation[field] = !relation[field];
    if (field === "following") targetStats.followers = Math.max(0, targetStats.followers + (relation.following ? 1 : -1));
    if (field === "liked") targetStats.likes = Math.max(0, targetStats.likes + (relation.liked ? 1 : -1));
  } else {
    targetStats[field] = (targetStats[field] || 0) + 1;
  }
  relations[relationKey] = relation;
  currentAccount.socialStats = relations;
  const currentIndex = accounts.findIndex(account => account.email === currentAccount.email);
  if (currentIndex >= 0) accounts[currentIndex] = currentAccount;
  const notification = field === "following" && relation.following
    ? { type: "follow", name: currentAccount.name, createdAt: new Date().toISOString() }
    : null;
  accounts[targetIndex] = {
    ...target,
    socialStats: { ...(target.socialStats || {}), own: targetStats },
    notifications: notification ? [...(target.notifications || []), notification] : (target.notifications || [])
  };
  localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
}

function renderProfilePosts(showPosts) {
  const list = $("profilePostList");
  profileMediaUrls.forEach(url => URL.revokeObjectURL(url));
  profileMediaUrls = [];
  list.replaceChildren();
  if (!showPosts) return;
  getAll("posts").then(posts => {
    const ownPosts = posts
      .filter(post => post.ownerEmail === currentAccount.email)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!ownPosts.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = text("noPosts");
      list.append(empty);
      return;
    }
    ownPosts.forEach(post => {
      const card = document.createElement("article");
      card.className = "profile-post-card";
      const header = document.createElement("div");
      header.className = "profile-post-card-header";
      const caption = document.createElement("p");
      caption.textContent = post.caption || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = text("removePost");
      remove.addEventListener("click", () => {
        storeRequest("posts", "readwrite", store => store.delete(post.id))
          .then(() => renderProfilePosts(true))
          .catch(showPostError);
      });
      header.append(caption, remove);
      const media = post.type.startsWith("video/")
        ? document.createElement("video")
        : document.createElement("img");
      const url = URL.createObjectURL(post.blob);
      profileMediaUrls.push(url);
      media.src = url;
      if (media instanceof HTMLVideoElement) media.controls = true;
      else media.alt = post.name || text("posts");
      card.append(header, media);
      list.append(card);
    });
  }).catch(showPostError);
}

function showPostError(error) {
  $("postError").textContent = `${text("storageError")} ${error.message || ""}`;
  $("postError").hidden = false;
  console.error("Could not load or save profile posts.", error);
}

function savePostFiles() {
  if (!pendingPostFiles.length) {
    $("postError").textContent = text("postMediaOnly");
    $("postError").hidden = false;
    return;
  }
  if (currentAccount.preferences?.privacy !== "global") {
    $("postError").textContent = text("postGlobalOnly");
    $("postError").hidden = false;
    return;
  }
  openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction("posts", "readwrite");
    const store = transaction.objectStore("posts");
    const caption = $("postCaption").value.trim();
    pendingPostFiles.forEach(file => store.add({
      id: crypto.randomUUID(),
      ownerEmail: currentAccount.email,
      caption,
      name: file.name,
      type: file.type,
      blob: file,
      createdAt: Date.now()
    }));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Unable to save profile post."));
    transaction.onabort = () => reject(transaction.error || new Error("Profile post save was cancelled."));
  })).then(() => {
    pendingPostFiles = [];
    $("postUpload").value = "";
    $("postCaption").value = "";
    $("profilePostComposer").hidden = true;
    $("postError").hidden = true;
    renderProfilePosts(true);
  }).catch(showPostError);
}

function openEditProfile() {
  $("profileDisplayName").value = currentAccount.name;
  pendingProfileImage = currentAccount.profileImage || null;
  $("profilePhotoError").hidden = true;
  applyProfilePreferences();
  $("profileDialog").showModal();
}

function openGroupDialog() {
  $("groupForm").reset();
  $("groupError").hidden = true;
  $("groupDialog").showModal();
}

function createGroup(name, members) {
  const chat = {
    name,
    preview: text("groupDemoNotice"),
    color: "purple",
    messages: [{ text: `${text("memberLabel")}: ${members.join(", ")}`, mine: false }],
    isGroup: true,
    members
  };
  chats.unshift(chat);
  activeChat = 0;
  saveChats();
  renderChats($("search").value);
  openChat(0);
}

function openBotChat() {
  let index = chats.findIndex(chat => chat.isBot);
  if (index < 0) {
    chats.unshift({
      name: text("botChatName"),
      preview: text("botWelcome"),
      color: "gold",
      isBot: true,
      messages: [{ text: text("botWelcome"), mine: false }]
    });
    index = 0;
    saveChats();
  }
  activeChat = index;
  renderChats($("search").value);
  openChat(index);
}

function openChat(index) {
  closeMobileMenu();
  if (readContactState()[chats[index].name]?.deleted) return;
  if (pendingReply && pendingReply.chatIndex !== index) clearReplyTarget();
  activeChat = index;
  $("activeName").textContent = chats[index].name;
  $("contactActionsBtn").hidden = Boolean(chats[index].isBot || chats[index].isGroup || chats[index].isNotes || chats[index].accountEmail);
  $("activeAvatar").textContent = initials(chats[index].name);
  $("activeAvatar").className = `avatar ${chats[index].color}`;
  const contactState = readContactState();
  const blocked = Boolean(contactState[chats[index].name]?.blocked || (chats[index].accountEmail && contactState.accountBlocks?.[chats[index].accountEmail]));
  $("messageInput").disabled = blocked || attachmentUploadInProgress;
  $("messageUpload").disabled = blocked || attachmentUploadInProgress;
  $("attachFilesBtn").classList.toggle("disabled", blocked || attachmentUploadInProgress);
  $("messageForm").querySelector("button[type=submit]").disabled = blocked || attachmentUploadInProgress;
  $("messageInput").placeholder = blocked ? text("friendBlocked") : text("writeMessage");
  drawMessages();
  renderChats($("search").value);
  document.body.classList.add("chat-open");
}

function contactStateKey() {
  return `bluebird-contacts-${encodeURIComponent(currentAccount?.email || "guest")}`;
}

function readContactState() {
  return JSON.parse(localStorage.getItem(contactStateKey()) || "{}");
}

function writeContactState(state) {
  localStorage.setItem(contactStateKey(), JSON.stringify(state));
}

function showContactToast(name, color, message) {
  $("toastName").textContent = name;
  $("toastMessage").textContent = message;
  $("toastAvatar").textContent = initials(name);
  $("toastAvatar").className = `avatar ${color || ""}`;
  $("messageToast").classList.toggle("blocked-alert", message === text("blockedByStatus").replace("{name}", name));
  $("messageToast").hidden = false;
  playIncomingSound();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("messageToast").hidden = true;
  }, 6500);
}

function consumeAccountNotifications() {
  if (!currentAccount) return;
  const accounts = accountList();
  const accountIndex = accounts.findIndex(account => account.email === currentAccount.email);
  if (accountIndex < 0) return;
  const account = accounts[accountIndex];
  const notifications = [...(account.notifications || [])];
  const notification = notifications.shift();
  if (!notification) return;
  const updatedAccount = { ...account, notifications };
  accounts[accountIndex] = updatedAccount;
  try {
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
    currentAccount = updatedAccount;
  } catch (error) {
    console.error("Could not save the read follow notification.", error);
    return;
  }
  const followerName = notification.name || text("newFollowerName");
  showContactToast(followerName, "purple", text("followerNotification").replace("{name}", followerName));
  if (notifications.length) setTimeout(consumeAccountNotifications, 6600);
}

window.addEventListener("storage", event => {
  if (event.key !== "bluebird-local-accounts" || !currentAccount) return;
  const updatedAccount = accountList().find(account => account.email === currentAccount.email);
  if (!updatedAccount) return;
  const previousRequestEmails = new Set((currentAccount.friendRequests || []).map(request => request.fromEmail));
  currentAccount = updatedAccount;
  updateFriendRequestTabCount();
  if (updatedAccount.notifications?.length) consumeAccountNotifications();
  if (!$("friendsView").hidden) {
    const activeSection = document.querySelector(".friend-center-tab.active")?.dataset.friendSection || "requests";
    renderFriendCenter(activeSection);
    if (activeSection === "search") renderFriendSearchResults();
  }
  const newRequest = (updatedAccount.friendRequests || []).find(request => !previousRequestEmails.has(request.fromEmail));
  if (newRequest) {
    const sender = accountList().find(account => account.email === newRequest.fromEmail);
    const senderName = sender?.name || text("newFollowerName");
    showContactToast(senderName, "purple", text("requestReceived").replace("{name}", senderName));
  }
});

function visibleChatIndices() {
  const state = readContactState();
  return chats.map((chat, index) => ({ chat, index }))
    .filter(({ chat }) => !chat.isAccountPreview && !state[chat.name]?.deleted)
    .map(({ index }) => index);
}

function visibleFriendCount() {
  return visibleChatIndices().filter(index => !chats[index].isBot && !chats[index].isGroup && !chats[index].isNotes).length;
}

function closeMobileMenu() {
  document.body.classList.remove("mobile-menu-open");
  const toggle = $("mobileMenuToggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", text("mobileMenu"));
    toggle.title = text("mobileMenu");
  }
  const backdrop = $("mobileMenuBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function toggleMobileMenu() {
  const open = !document.body.classList.contains("mobile-menu-open");
  document.body.classList.toggle("mobile-menu-open", open);
  $("mobileMenuBackdrop").hidden = !open;
  $("mobileMenuToggle").setAttribute("aria-expanded", String(open));
  $("mobileMenuToggle").setAttribute("aria-label", text(open ? "closeMobileMenu" : "mobileMenu"));
  $("mobileMenuToggle").title = text(open ? "closeMobileMenu" : "mobileMenu");
}

function ensureNotesChat() {
  let notesIndex = chats.findIndex(chat => chat.isNotes);
  if (notesIndex < 0) {
    chats.push({
      name: text("myNotes"),
      color: "purple",
      messages: [],
      preview: "",
      isNotes: true
    });
    notesIndex = chats.length - 1;
    saveChats();
  }
  openChat(notesIndex);
  renderChats($("search").value);
  return chats[notesIndex];
}

function showNoActiveChat() {
  activeChat = -1;
  $("activeName").textContent = text("messages");
  $("activeAvatar").textContent = "";
  $("messages").replaceChildren();
  const note = document.createElement("p");
  note.className = "empty-chat-note";
  note.textContent = text("trySomething");
  $("messages").append(note);
  $("messageInput").disabled = false;
  $("messageUpload").disabled = false;
  $("attachFilesBtn").classList.remove("disabled");
  $("messageForm").querySelector("button[type=submit]").disabled = false;
  $("contactActionsBtn").hidden = true;
}

function refreshActiveChatAfterRemoval() {
  const available = visibleChatIndices();
  if (!available.length) {
    renderChats($("search").value);
    showNoActiveChat();
    return;
  }
  const next = available.includes(activeChat) ? activeChat : available[0];
  openChat(next);
}

function openContactActions() {
  if (chats[activeChat]?.isBot || chats[activeChat]?.isGroup || chats[activeChat]?.isNotes) return;
  if (readContactState()[chats[activeChat].name]?.deleted) return;
  contactActionsIndex = activeChat;
  const chat = chats[activeChat];
  $("contactDialogName").textContent = chat.name;
  $("contactDialogAvatar").textContent = initials(chat.name);
  $("contactDialogAvatar").className = `avatar ${chat.color}`;
  const blocked = Boolean(readContactState()[chat.name]?.blocked);
  $("blockFriendBtn").textContent = text(blocked ? "unblockFriend" : "blockFriend");
  $("blockFriendBtn").classList.toggle("is-blocked", !blocked);
  $("blockFriendBtn").classList.toggle("is-unblocked", blocked);
  $("friendVisibilityBtn").textContent = text(readContactState()[chat.name]?.profileHidden ? "showFriendProfile" : "hideFriendProfile");
  $("contactDialog").showModal();
}

function drawMessages() {
  const box = $("messages");
  box.replaceChildren();
  messageMediaUrls.forEach(url => URL.revokeObjectURL(url));
  messageMediaUrls = [];
  if (chats[activeChat].isNotes && !chats[activeChat].messages.length) {
    const note = document.createElement("p");
    note.className = "empty-chat-note";
    note.textContent = text("trySomething");
    box.append(note);
    return;
  }
  const day = document.createElement("div");
  day.className = "day";
  day.textContent = text("today");
  box.append(day);
  const filter = $("messageFilterInput").value.trim().toLocaleLowerCase();
  const visibleMessages = chats[activeChat].messages
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !filter || `${item.text || ""} ${item.name || ""}`.toLocaleLowerCase().includes(filter));
  if (!visibleMessages.length && filter) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = text("noMatchingMessages");
    box.append(empty);
  }
  visibleMessages.forEach(({ item, index }) => {
    const row = document.createElement("div");
    row.className = `message-row ${item.mine ? "mine" : "theirs"}`;
    const bubble = document.createElement("div");
    bubble.className = `message ${item.mine ? "mine" : "theirs"}`;
    bubble.dataset.messageIndex = String(index);
    if (item.pinned) {
      const pinned = document.createElement("span");
      pinned.className = "message-pin-indicator";
      pinned.textContent = `📌 ${text("pinnedMessage")}`;
      bubble.append(pinned);
    }
    if (item.replyTo?.text) {
      const quote = document.createElement("div");
      quote.className = "message-reply-quote";
      quote.textContent = item.replyTo.text;
      bubble.append(quote);
    }
    if (item.attachmentId) {
      renderMessageAttachment(item, bubble, activeChat);
    } else {
      const content = document.createElement("span");
      content.className = "message-text";
      content.textContent = item.text || "";
      bubble.append(content);
    }
    const actionButton = document.createElement("button");
    actionButton.className = "message-more icon-btn";
    actionButton.type = "button";
    actionButton.textContent = "⋯";
    actionButton.setAttribute("aria-label", text("messageActions"));
    actionButton.title = text("messageActions");
    actionButton.addEventListener("click", () => openMessageActions(activeChat, index));
    bubble.append(actionButton);
    row.append(bubble);
    box.append(row);
  });
  box.scrollTop = box.scrollHeight;
}

function renderMessageAttachment(message, bubble, chatIndex) {
  getRecord("attachments", message.attachmentId).then(attachment => {
    if (!attachment || attachment.ownerEmail !== currentAccount.email || activeChat !== chatIndex ||
        !bubble.isConnected || chats[chatIndex].messages[Number(bubble.dataset.messageIndex)] !== message) return;
    const url = URL.createObjectURL(attachment.blob);
    messageMediaUrls.push(url);
    let media;
    if (attachment.type.startsWith("image/")) {
      media = document.createElement("img");
      media.alt = attachment.name;
      media.className = `message-media${message.blurred ? " blurred" : ""}`;
    } else if (attachment.type.startsWith("video/")) {
      media = document.createElement("video");
      media.controls = true;
      media.preload = "metadata";
      media.className = "message-media";
    } else if (attachment.type.startsWith("audio/")) {
      media = document.createElement("audio");
      media.preload = "metadata";
      media.className = "voice-message-audio";
      media.src = url;
      const player = createVoiceMessagePlayer(media);
      bubble.classList.add("voice-message-bubble");
      bubble.insertBefore(player, bubble.querySelector(".message-more"));
      bubble.dataset.attachmentName = attachment.name;
      bubble.dataset.attachmentSize = String(attachment.size);
      return;
    }
    if (media) {
      media.src = url;
      bubble.insertBefore(media, bubble.querySelector(".message-more"));
    }
    bubble.dataset.attachmentName = attachment.name;
    bubble.dataset.attachmentSize = String(attachment.size);
  }).catch(error => {
    if (!bubble.isConnected) return;
    const errorLabel = document.createElement("span");
    errorLabel.className = "message-media-error";
    errorLabel.textContent = `${text("uploadFailed")} ${error.message}`;
    bubble.insertBefore(errorLabel, bubble.querySelector(".message-more"));
    console.error("Could not load a chat attachment.", error);
  });
}

function formatVoiceTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function createVoiceMessagePlayer(audio) {
  const player = document.createElement("div");
  player.className = "voice-message-player";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "voice-message-play";
  toggleButton.textContent = "▶";
  toggleButton.setAttribute("aria-label", text("playVoiceMessage"));
  toggleButton.title = text("playVoiceMessage");

  const waveform = document.createElement("span");
  waveform.className = "voice-message-waveform";
  waveform.setAttribute("aria-hidden", "true");
  const heights = [30, 48, 68, 42, 78, 54, 88, 62, 40, 72, 50, 82, 44, 64, 34, 74, 52, 86, 42, 60, 32, 70];
  heights.forEach(height => {
    const bar = document.createElement("span");
    bar.className = "voice-message-wave-bar";
    bar.style.height = `${height}%`;
    waveform.append(bar);
  });

  const elapsed = document.createElement("span");
  elapsed.className = "voice-message-time";
  elapsed.textContent = "0:00";

  function updatePlayback() {
    const playing = !audio.paused && !audio.ended;
    toggleButton.textContent = playing ? "Ⅱ" : "▶";
    toggleButton.setAttribute("aria-label", text(playing ? "pauseVoiceMessage" : "playVoiceMessage"));
    toggleButton.title = toggleButton.getAttribute("aria-label");
    elapsed.textContent = formatVoiceTime(playing || audio.currentTime > 0
      ? audio.currentTime
      : audio.duration);
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    Array.from(waveform.children).forEach((bar, index) => {
      bar.classList.toggle("played", index / waveform.children.length < progress);
    });
    player.classList.toggle("is-playing", playing);
  }

  toggleButton.addEventListener("click", async () => {
    if (audio.paused) {
      try {
        await audio.play();
      } catch (error) {
        console.error("Could not play the voice message.", error);
        showContactToast(text("localAccount"), "", text("voiceMessagePlaybackFailed"));
      }
    } else {
      audio.pause();
    }
    updatePlayback();
  });
  audio.addEventListener("timeupdate", updatePlayback);
  audio.addEventListener("loadedmetadata", updatePlayback);
  audio.addEventListener("play", updatePlayback);
  audio.addEventListener("pause", updatePlayback);
  audio.addEventListener("ended", updatePlayback);
  audio.addEventListener("error", () => {
    showContactToast(text("localAccount"), "", text("voiceMessagePlaybackFailed"));
  }, { once: true });

  player.append(toggleButton, waveform, elapsed, audio);
  return player;
}

function createMessageActionRail(message, chatIndex, messageIndex) {
  const rail = document.createElement("div");
  rail.className = "message-action-rail";
  if (message.attachmentId) {
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "message-rail-button";
    downloadButton.textContent = "↓";
    downloadButton.title = text("downloadFile");
    downloadButton.setAttribute("aria-label", text("downloadFile"));
    downloadButton.addEventListener("click", () => downloadMessageAttachment(message));
    rail.append(downloadButton);
  } else if (message.text) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-rail-button";
    copyButton.textContent = "⧉";
    copyButton.title = text("copyMessage");
    copyButton.setAttribute("aria-label", text("copyMessage"));
    copyButton.addEventListener("click", () => copyPlainMessage(message));
    rail.append(copyButton);
  }
  if (message.text || message.name) {
    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.className = "message-rail-button";
    replyButton.textContent = "↩";
    replyButton.title = text("replyMessage");
    replyButton.setAttribute("aria-label", text("replyMessage"));
    replyButton.addEventListener("click", () => setReplyTarget(chatIndex, messageIndex));
    rail.append(replyButton);
  }
  const pinButton = document.createElement("button");
  pinButton.type = "button";
  pinButton.className = "message-rail-button";
  pinButton.textContent = "📌";
  pinButton.title = text(message.pinned ? "unpinMessage" : "pinMessage");
  pinButton.setAttribute("aria-label", pinButton.title);
  pinButton.setAttribute("aria-pressed", String(Boolean(message.pinned)));
  pinButton.addEventListener("click", () => toggleMessagePin(chatIndex, messageIndex));
  rail.append(pinButton);
  return rail;
}

async function downloadMessageAttachment(message) {
  if (!message?.attachmentId) return;
  try {
    const attachment = await getRecord("attachments", message.attachmentId);
    if (!attachment || attachment.ownerEmail !== currentAccount.email) {
      throw new Error("The selected file is unavailable.");
    }
    const url = URL.createObjectURL(attachment.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    $("messageUploadError").textContent = `${text("uploadFailed")} ${error.message}`;
    $("messageUploadError").hidden = false;
    console.error("Could not download the selected attachment.", error);
  }
}

function toggleMessagePin(chatIndex, messageIndex) {
  const message = chats[chatIndex]?.messages[messageIndex];
  if (!message) return;
  message.pinned = !message.pinned;
  saveChats();
  if (activeChat === chatIndex) drawMessages();
}

function openMessageActions(chatIndex, messageIndex) {
  selectedMessage = { chatIndex, messageIndex };
  const message = chats[chatIndex]?.messages[messageIndex];
  if (!message) return;
  $("messageActionSummary").textContent = message.text || message.name || "";
  const isAttachment = Boolean(message.attachmentId);
  const isViewableMedia = message.type?.startsWith("image/") || message.type?.startsWith("video/");
  $("downloadMessageBtn").hidden = !isAttachment;
  $("viewMessageMediaBtn").hidden = !isViewableMedia;
  $("editMessageBtn").hidden = !message.mine || isAttachment || !message.text;
  $("replyMessageBtn").hidden = !message.text && !message.name;
  $("pinMessageBtn").textContent = text(message.pinned ? "unpinMessage" : "pinMessage");
  $("copyMessageBtn").hidden = isAttachment || !message.text;
  const isImage = message.type?.startsWith("image/");
  $("blurMessageBtn").hidden = !isImage;
  $("blurMessageBtn").textContent = text(message.blurred ? "unblurImage" : "blurImage");
  $("messageActionFeedback").hidden = true;
  $("messageActionsDialog").showModal();
}

function openMessageEditor() {
  if (!selectedMessage) return;
  const message = chats[selectedMessage.chatIndex]?.messages[selectedMessage.messageIndex];
  if (!message?.mine || message.attachmentId || !message.text) return;
  $("editMessageInput").value = message.text;
  $("editMessageError").hidden = true;
  $("messageActionsDialog").close();
  $("editMessageDialog").showModal();
  $("editMessageInput").focus();
  $("editMessageInput").select();
}

function saveEditedMessage() {
  if (!selectedMessage) return;
  const updatedText = $("editMessageInput").value.trim();
  if (!updatedText) {
    $("editMessageError").textContent = text("editedMessageEmpty");
    $("editMessageError").hidden = false;
    $("editMessageInput").focus();
    return;
  }
  const { chatIndex, messageIndex } = selectedMessage;
  const chat = chats[chatIndex];
  const message = chat?.messages[messageIndex];
  if (!message?.mine || message.attachmentId) return;
  message.text = updatedText;
  if (messageIndex === chat.messages.length - 1) chat.preview = updatedText;
  saveChats();
  $("editMessageDialog").close();
  if (activeChat === chatIndex) drawMessages();
  renderChats($("search").value);
}

function messagePreview(message) {
  return String(message?.text || message?.name || "").trim();
}

function setReplyTarget(chatIndex, messageIndex) {
  const message = chats[chatIndex]?.messages[messageIndex];
  if (!message) return;
  pendingReply = { chatIndex, messageIndex, text: messagePreview(message) };
  $("replyContextText").textContent = pendingReply.text;
  $("replyContext").hidden = false;
  $("messageActionsDialog").close();
  $("messageInput").focus();
}

function clearReplyTarget() {
  pendingReply = null;
  $("replyContext").hidden = true;
  $("replyContextText").textContent = "";
}

async function copyPlainMessage(message) {
  if (!message?.text || message.attachmentId) return;
  const inDialog = $("messageActionsDialog").open;
  try {
    await navigator.clipboard.writeText(message.text);
    if (inDialog) {
      $("messageActionFeedback").textContent = text("copied");
      $("messageActionFeedback").hidden = false;
    } else {
      showContactToast(text("localAccount"), "purple", text("copied"));
    }
  } catch (error) {
    if (inDialog) {
      $("messageActionFeedback").textContent = `${text("messageCopyFailed")} ${error.message}`;
      $("messageActionFeedback").hidden = false;
    } else {
      showContactToast(text("localAccount"), "purple", text("messageCopyFailed"));
    }
    console.error("Could not copy the selected text message.", error);
  }
}

async function viewSelectedAttachment() {
  if (!selectedMessage) return;
  const message = chats[selectedMessage.chatIndex]?.messages[selectedMessage.messageIndex];
  if (!message?.attachmentId || !(message.type?.startsWith("image/") || message.type?.startsWith("video/"))) return;
  try {
    const attachment = await getRecord("attachments", message.attachmentId);
    if (!attachment || attachment.ownerEmail !== currentAccount.email) {
      throw new Error("The selected media is unavailable.");
    }
    if (viewerMediaUrl) URL.revokeObjectURL(viewerMediaUrl);
    viewerMediaUrl = URL.createObjectURL(attachment.blob);
    const body = $("mediaViewerBody");
    body.replaceChildren();
    const media = document.createElement(attachment.type.startsWith("video/") ? "video" : "img");
    media.className = "media-viewer-media";
    media.src = viewerMediaUrl;
    if (media instanceof HTMLVideoElement) {
      media.controls = true;
      media.autoplay = true;
    } else {
      media.alt = attachment.name;
    }
    const caption = document.createElement("p");
    caption.textContent = attachment.name;
    body.append(media, caption);
    $("messageActionsDialog").close();
    $("mediaViewerDialog").showModal();
  } catch (error) {
    $("messageActionFeedback").textContent = `${text("uploadFailed")} ${error.message}`;
    $("messageActionFeedback").hidden = false;
    console.error("Could not open the selected media.", error);
  }
}

function deleteSelectedMessage() {
  if (!selectedMessage) return;
  const { chatIndex, messageIndex } = selectedMessage;
  const message = chats[chatIndex]?.messages[messageIndex];
  if (!message) return;
  const remove = message.attachmentId
    ? storeRequest("attachments", "readwrite", store => store.delete(message.attachmentId))
    : Promise.resolve();
  remove.then(() => {
    chats[chatIndex].messages.splice(messageIndex, 1);
    const remaining = chats[chatIndex].messages;
    chats[chatIndex].preview = remaining.length ? (remaining[remaining.length - 1].text || "") : "";
    saveChats();
    if (activeChat === chatIndex) drawMessages();
    renderChats($("search").value);
    $("messageActionsDialog").close();
  }).catch(error => {
    $("messageActionFeedback").textContent = `${text("uploadFailed")} ${error.message}`;
    $("messageActionFeedback").hidden = false;
    console.error("Could not delete the selected message.", error);
  });
}

function uploadMessageFiles(files) {
  if (!files.length) return;
  if (!chats[activeChat]) ensureNotesChat();
  const chat = chats[activeChat];
  const uploadState = readContactState();
  if (!chat || uploadState[chat.name]?.blocked || uploadState[chat.name]?.deleted ||
    (chat.accountEmail && uploadState.accountBlocks?.[chat.accountEmail])) return;
  const chatIndex = activeChat;
  const input = $("messageUpload");
  const uploadStartedAt = performance.now();
  $("messageUploadError").hidden = true;
  attachmentUploadInProgress = true;
  $("attachmentUploadOverlay").hidden = false;
  $("conversation").setAttribute("aria-busy", "true");
  $("messageInput").disabled = true;
  $("messageUpload").disabled = true;
  $("messageForm").querySelector("button[type=submit]").disabled = true;
  $("attachFilesBtn").classList.add("disabled");
  openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction("attachments", "readwrite");
    const store = transaction.objectStore("attachments");
    const messages = files.map(file => {
      const id = crypto.randomUUID();
      const type = file.type || "application/octet-stream";
      store.add({
        id,
        ownerEmail: currentAccount.email,
        chatName: chat.name,
        name: file.name,
        type,
        size: file.size,
        blob: file
      });
      return {
        attachmentId: id,
        name: file.name,
        type,
        size: file.size,
        text: file.name,
        mine: true,
        replyTo: pendingReply?.chatIndex === chatIndex ? { text: pendingReply.text } : null,
        sentAt: Date.now()
      };
    });
    transaction.oncomplete = () => resolve(messages);
    transaction.onerror = () => reject(transaction.error || new Error("The browser could not store the selected files."));
    transaction.onabort = () => reject(transaction.error || new Error("The browser cancelled this file upload."));
  })).then(messages => {
    chats[chatIndex].messages.push(...messages);
    chats[chatIndex].preview = messages[messages.length - 1].name;
    if (pendingReply?.chatIndex === chatIndex) clearReplyTarget();
    saveChats();
    if (activeChat === chatIndex) drawMessages();
    renderChats($("search").value);
  }).catch(error => {
    $("messageUploadError").textContent = `${text("uploadFailed")} ${error.message}`;
    $("messageUploadError").hidden = false;
    console.error("Could not save chat attachments.", error);
  }).finally(async () => {
    const remainingVisibleTime = 350 - (performance.now() - uploadStartedAt);
    if (remainingVisibleTime > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingVisibleTime));
    }
    input.value = "";
    attachmentUploadInProgress = false;
    $("attachmentUploadOverlay").hidden = true;
    $("conversation").removeAttribute("aria-busy");
    const active = chats[activeChat];
    const state = readContactState();
    const blocked = Boolean(active && (
      state[active.name]?.blocked ||
      state[active.name]?.deleted ||
      (active.accountEmail && state.accountBlocks?.[active.accountEmail])
    ));
    $("messageInput").disabled = !active || blocked;
    $("messageUpload").disabled = !active || blocked;
    $("messageForm").querySelector("button[type=submit]").disabled = !active || blocked;
    $("attachFilesBtn").classList.toggle("disabled", !active || blocked);
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("bluebird-theme", theme);
  document.querySelectorAll(".theme-choice").forEach(button => {
    const active = button.dataset.themeChoice === theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function profilePreferences() {
  return currentAccount?.preferences || {};
}

function applyProfilePreferences() {
  const preferences = profilePreferences();
  const root = document.documentElement;
  root.style.setProperty("--mine", preferences.myMessageColor || "");
  root.style.setProperty("--bubble", preferences.friendMessageColor || "");
  $("myMessageColor").value = preferences.myMessageColor || (root.dataset.theme === "dark" ? "#303642" : "#dbeafe");
  $("friendMessageColor").value = preferences.friendMessageColor || (root.dataset.theme === "dark" ? "#292929" : "#ffffff");
  $("profilePrivacy").value = preferences.privacy || "private";
  $("profilePrivacyMenu").value = preferences.privacy || "private";
  $("requireAppPinToggle").checked = preferences.requirePin !== false;
  updateProfileAvatar();
  updateLockButton();
}

function saveProfilePreferences(patch) {
  currentAccount.preferences = { ...profilePreferences(), ...patch };
  const accounts = accountList();
  const index = accounts.findIndex(account => account.email === currentAccount.email);
  if (index >= 0) {
    accounts[index] = currentAccount;
    try {
      localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
    } catch (error) {
      $("settingsNotice").textContent = `${text("storageError")} ${error.message}`;
      console.error("Could not save profile preferences.", error);
    }
  }
  applyProfilePreferences();
}

function updateProfileAvatar() {
  const image = currentAccount?.profileImage;
  const avatarImage = $("profileAvatarImage");
  if (image) {
    avatarImage.src = image;
    avatarImage.hidden = false;
    $("profileAvatarInitials").hidden = true;
    $("profileImagePreview").src = image;
    $("profileImagePreview").hidden = false;
    $("profileImagePlaceholder").hidden = true;
  } else {
    avatarImage.removeAttribute("src");
    avatarImage.hidden = true;
    $("profileAvatarInitials").hidden = false;
    $("profileAvatarInitials").textContent = initials(currentAccount?.name || "Guest");
    $("profileImagePreview").removeAttribute("src");
    $("profileImagePreview").hidden = true;
    $("profileImagePlaceholder").hidden = false;
    $("profileImagePlaceholder").textContent = initials(currentAccount?.name || "Guest");
  }
}

function setReducedMotion(enabled) {
  if (enabled) document.documentElement.dataset.motion = "off";
  else delete document.documentElement.dataset.motion;
  localStorage.setItem("bluebird-motion", enabled ? "off" : "on");
  $("motionToggle").checked = enabled;
}

function updateCodeFileName() {
  const file = `main.${extensionByLanguage[$("languageSelect").value]}`;
  $("fileName").textContent = `✦ ${file}`;
  $("editorTab").textContent = `✦  ${file}`;
}

function updateOfflineScreen() {
  $("offlineScreen").hidden = navigator.onLine;
}

function updateLineNumbers() {
  const count = $("codeEditor").value.split("\n").length;
  $("lineNumbers").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
}

function showAccount(account) {
  account = ensureAccountIdentity(account);
  mobileAppLocked = false;
  currentAccount = account;
  loadChats(account);
  updateFriendRequestTabCount();
  localStorage.setItem("bluebird-session", account.email);
  $("authScreen").hidden = true;
  $("app").hidden = false;
  $("profileName").textContent = account.name;
  $("profileMode").textContent = text("localAccount");
  applyProfilePreferences();
  const availableChats = visibleChatIndices();
  if (availableChats.length) {
    openChat(availableChats[0]);
    document.body.classList.remove("chat-open");
  } else {
    renderChats();
    showNoActiveChat();
  }
  openDatabase().then(renderFolders).catch(showFilesError);
  consumeAccountNotifications();
  if (account.welcomePending && !$("firstWelcomeDialog").open) {
    $("firstWelcomeDialog").showModal();
  }
}

function updateLockButton() {
  const button = $("signOutBtn");
  if (!button) return;
  const requirePin = Boolean(currentAccount?.appPinHash && currentAccount.preferences?.requirePin !== false);
  button.textContent = requirePin ? "🔒" : "↪";
  button.title = text(requirePin ? "lockApp" : "signOut");
  button.setAttribute("aria-label", button.title);
}

function openPinDialog(mode, account) {
  pinFlowMode = mode;
  pinFlowAccount = account;
  pinRecoveryCode = null;
  const setup = mode === "setup";
  const reset = mode === "reset";
  $("pinCodeStage").hidden = false;
  $("pinRecoveryStage").hidden = true;
  $("pinConfirmGroup").hidden = !setup && !reset;
  $("forgotAppPinBtn").hidden = mode !== "unlock" || isMobileScreen();
  $("pinError").hidden = true;
  $("pinRecoveryError").hidden = true;
  $("appPinInput").value = "";
  $("appPinConfirmInput").value = "";
  $("pinRecoveryCodeInput").value = "";
  $("pinDialogTitle").textContent = text(setup ? "setupPinTitle" : reset ? "resetPinTitle" : "unlockPinTitle");
  $("pinDialogDescription").textContent = text(setup ? "setupPinDescription" : reset ? "resetPinDescription" : "unlockPinDescription");
  $("appPinLabel").textContent = text("fourDigitCode");
  $("appPinConfirmLabel").textContent = text("confirmFourDigitCode");
  $("submitAppPin").textContent = text(setup || reset ? "saveAppPin" : "unlockApp");
  const dialog = $("pinDialog");
  if (!dialog.open) dialog.showModal();
  $("appPinInput").focus();
}

function createPinRecoveryCode() {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String(random[0] % 1000000).padStart(6, "0");
}

async function hashAppPin(pin, salt) {
  if (!crypto.subtle) throw new Error("Secure PIN storage is unavailable in this browser.");
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function storeAccountPin(account, pin) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const updated = {
    ...account,
    appPinSalt: salt,
    appPinHash: await hashAppPin(pin, salt),
    preferences: { ...(account.preferences || {}), requirePin: true }
  };
  const accounts = accountList();
  const index = accounts.findIndex(item => item.email === updated.email);
  if (index >= 0) accounts[index] = updated;
  else accounts.push(updated);
  localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  pinFlowAccount = updated;
}

async function openAccountAccess(account) {
  account = ensureAccountIdentity(account);
  if (isMobileScreen()) {
    $("app").hidden = true;
    $("authScreen").hidden = true;
  }
  if (!account.appPinHash || !account.appPinSalt) {
    openPinDialog("setup", account);
    return;
  }
  if (isMobileScreen() || account.preferences?.requirePin !== false) {
    openPinDialog("unlock", account);
    return;
  }
  await withAccountLoading("openingAccount", () => showAccount(account));
}

async function submitAppPin() {
  const pin = $("appPinInput").value;
  if (!/^\d{4}$/.test(pin)) {
    $("pinError").textContent = text("pinMustBeFourDigits");
    $("pinError").hidden = false;
    return;
  }
  try {
    if (pinFlowMode === "unlock") {
      const digest = await hashAppPin(pin, pinFlowAccount.appPinSalt);
      if (digest !== pinFlowAccount.appPinHash) {
        $("pinError").textContent = text("invalidAppPin");
        $("pinError").hidden = false;
        $("appPinInput").select();
        return;
      }
    } else {
      if ($("appPinConfirmInput").value !== pin) {
        $("pinError").textContent = text("pinMismatch");
        $("pinError").hidden = false;
        $("appPinConfirmInput").focus();
        return;
      }
      await storeAccountPin(pinFlowAccount, pin);
    }
    const account = pinFlowAccount;
    $("pinDialog").close();
    await withAccountLoading("openingAccount", () => showAccount(account));
  } catch (error) {
    $("pinError").textContent = `${text("storageError")} ${error.message || ""}`;
    $("pinError").hidden = false;
    console.error("Could not validate or save the local app PIN.", error);
  }
}

function startPinRecovery() {
  if (!pinFlowAccount) return;
  pinFlowMode = "recovery";
  pinRecoveryCode = createPinRecoveryCode();
  $("pinCodeStage").hidden = true;
  $("pinRecoveryStage").hidden = false;
  $("pinRecoveryDemoCode").textContent = pinRecoveryCode;
  $("pinRecoveryCodeInput").value = "";
  $("pinRecoveryError").hidden = true;
  $("pinRecoveryCodeInput").focus();
}

function verifyPinRecovery() {
  if (!pinRecoveryCode || $("pinRecoveryCodeInput").value !== pinRecoveryCode) {
    $("pinRecoveryError").textContent = text("invalidPinRecoveryCode");
    $("pinRecoveryError").hidden = false;
    return;
  }
  openPinDialog("reset", pinFlowAccount);
}

function signOutAccount() {
  localStorage.removeItem("bluebird-session");
  if ($("pinDialog").open) $("pinDialog").close();
  currentAccount = null;
  mobileAppLocked = false;
  pinFlowAccount = null;
  $("app").hidden = true;
  $("authScreen").hidden = false;
  $("authForm").reset();
  setAccountMode("signin");
  updateLockButton();
}

function isMobileScreen() {
  const narrowViewport = window.matchMedia("(max-width: 760px)").matches;
  const compactTouchDevice = window.matchMedia("(pointer: coarse)").matches &&
    Math.min(window.screen.width, window.screen.height) <= 900;
  return narrowViewport || compactTouchDevice;
}

function lockMobileApp() {
  if (!isMobileScreen() || !currentAccount || $("app").hidden || mobileAppLocked) return;
  mobileAppLocked = true;
  $("app").hidden = true;
  $("authScreen").hidden = true;
  document.querySelectorAll("dialog[open]").forEach(dialog => {
    if (dialog.id !== "pinDialog") dialog.close();
  });
  openPinDialog("unlock", currentAccount);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    lockMobileApp();
    return;
  }
  if (mobileAppLocked && currentAccount) {
    if (!$("pinDialog").open) openPinDialog("unlock", currentAccount);
    $("appPinInput").focus();
  }
});

window.addEventListener("pagehide", lockMobileApp);
window.addEventListener("pageshow", () => {
  if (mobileAppLocked && currentAccount && !$("pinDialog").open) {
    openPinDialog("unlock", currentAccount);
  }
});

$("pinDialog").addEventListener("cancel", event => {
  if (mobileAppLocked) event.preventDefault();
});

function signOut() {
  if (currentAccount?.appPinHash && currentAccount.preferences?.requirePin !== false) {
    openPinDialog("unlock", currentAccount);
    return;
  }
  signOutAccount();
}

async function withAccountLoading(messageKey, action) {
  if (accountOperationInProgress) return;
  accountOperationInProgress = true;
  const dialog = $("accountLoading");
  $("accountLoadingText").textContent = text(messageKey);
  dialog.showModal();
  try {
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 180)));
    return await action();
  } finally {
    if (dialog.open) dialog.close();
    accountOperationInProgress = false;
  }
}

function setAccountMode(mode) {
  accountMode = mode;
  pendingVerification = null;
  $("authError").hidden = true;
  $("verificationStep").hidden = true;
  $("authEntry").hidden = false;
  $("authSubmit").textContent = text(mode === "signin" ? "signIn" : "createAccount");
  $("signInMode").classList.toggle("active", mode === "signin");
  $("signUpMode").classList.toggle("active", mode === "signup");
}

function showAuthError(message) {
  $("authError").textContent = message;
  $("authError").hidden = false;
}

function accountList() {
  return JSON.parse(localStorage.getItem("bluebird-local-accounts") || "[]");
}

function makeUsername(email, accounts, currentEmail = null) {
  const base = (email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "") || "member").slice(0, 24);
  let username = base;
  let suffix = 2;
  const usedByOther = value => accounts.some(account =>
    account.email !== currentEmail && account.username?.toLowerCase() === value.toLowerCase()
  );
  while (usedByOther(username)) username = `${base.slice(0, 24 - String(suffix).length)}${suffix++}`;
  return username;
}

function ensureAccountIdentity(account) {
  const accounts = accountList();
  let friendQrId = account.friendQrId;
  if (!friendQrId) {
    const friendQrBytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(friendQrBytes);
    } else {
      friendQrBytes.forEach((_, index) => { friendQrBytes[index] = Math.floor(Math.random() * 256); });
    }
    friendQrId = Array.from(friendQrBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  const username = account.username && !accounts.some(item =>
    item.email !== account.email && item.username?.toLowerCase() === account.username.toLowerCase()
  ) ? account.username : makeUsername(account.email, accounts, account.email);
  const normalized = {
    ...account,
    username,
    friendQrId,
    createdAt: account.createdAt || new Date().toISOString(),
    socialStats: {
      ...(account.socialStats || {}),
      own: account.socialStats?.own || { followers: 0, friends: 0, views: 0, likes: 0 }
    }
  };
  const index = accounts.findIndex(item => item.email === normalized.email);
  if (index >= 0 && (
    accounts[index].username !== normalized.username ||
    accounts[index].friendQrId !== normalized.friendQrId ||
    !accounts[index].createdAt
  )) {
    accounts[index] = normalized;
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  }
  return normalized;
}

async function saveAccount(account, openAfterSave = true) {
  await withAccountLoading("savingAccount", () => {
    account = ensureAccountIdentity(account);
    const accounts = accountList();
    const existing = accounts.findIndex(item => item.email === account.email);
    if (existing >= 0) accounts[existing] = account;
    else accounts.push(account);
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  });
  if (openAfterSave) await withAccountLoading("openingAccount", () => showAccount(account));
  return account;
}

function startEmailVerification(account, purpose = "signup") {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  pendingVerification = {
    account,
    purpose,
    code: String(random[0] % 1000000).padStart(6, "0")
  };
  $("authEntry").hidden = true;
  $("verificationStep").hidden = false;
  $("verificationError").hidden = true;
  $("demoVerificationCode").textContent = pendingVerification.code;
  $("verificationPurposeNote").textContent = purpose === "rename"
    ? text("verificationForName").replace("{email}", currentAccount.email)
    : text("verificationDemo");
  $("verificationCode").value = "";
  $("verificationCode").focus();
}

async function verifyPendingEmail() {
  if (!pendingVerification) return;
  if ($("verificationCode").value !== pendingVerification.code) {
    $("verificationError").textContent = text("invalidCode");
    $("verificationError").hidden = false;
    return;
  }
  const verification = pendingVerification;
  const account = {
    ...verification.account,
    emailVerified: true,
    ...(verification.purpose === "signup" ? { welcomePending: true } : {})
  };
  if (verification.purpose === "rename") {
    const duplicate = accountList().some(item =>
      item.email !== account.email && String(item.name || "").trim().toLocaleLowerCase() === account.name.trim().toLocaleLowerCase()
    );
    if (duplicate || account.email !== currentAccount?.email) {
      $("verificationError").textContent = duplicate ? text("duplicateDisplayName") : text("invalidCode");
      $("verificationError").hidden = false;
      return;
    }
  }
  try {
    const shouldOpenAfterSave = verification.purpose !== "signup" && verification.purpose !== "signin";
    const savedAccount = await saveAccount(account, shouldOpenAfterSave);
    pendingVerification = null;
    if (verification.purpose === "rename") {
      $("profileDialog").close();
      openProfile(true, null, "chat", false);
      showContactToast(account.name, "purple", text("nameChanged"));
    } else if (verification.purpose === "signin") {
      openPinDialog(savedAccount.appPinHash ? "unlock" : "setup", savedAccount);
    } else {
      openPinDialog("setup", savedAccount);
    }
  } catch (error) {
    $("verificationError").textContent = `${text("storageError")} ${error.message || ""}`;
    $("verificationError").hidden = false;
    console.error("Could not save the verified local account.", error);
  }
}

function openDatabase() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bluebird-local-files", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
      if (!db.objectStoreNames.contains("posts")) db.createObjectStore("posts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("attachments")) db.createObjectStore("attachments", { keyPath: "id" });
    };
    request.onsuccess = () => {
      database = request.result;
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("Unable to open local file storage."));
  });
}

function storeRequest(storeName, mode, action) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local storage operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local storage transaction failed."));
  }));
}

function getAll(storeName) {
  return storeRequest(storeName, "readonly", store => store.getAll());
}

function getRecord(storeName, id) {
  return storeRequest(storeName, "readonly", store => store.get(id));
}

function renderFolders() {
  if (!database || $("app").hidden) return;
  Promise.all([getAll("folders"), getAll("files")]).then(([folders, files]) => {
    folders = folders.filter(folder => folder.ownerEmail === currentAccount.email);
    files = files.filter(file => file.ownerEmail === currentAccount.email);
    const grid = $("folderGrid");
    grid.replaceChildren();
    if (!folders.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = text("noFolders");
      grid.append(empty);
      currentFolderId = null;
      $("selectedFolderName").textContent = "";
      renderStoredFiles([]);
      return;
    }
    if (!folders.some(folder => folder.id === currentFolderId)) currentFolderId = folders[0].id;
    folders.forEach(folder => {
      const card = document.createElement("div");
      card.className = `folder-card${folder.id === currentFolderId ? " active" : ""}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = "folder-select";
      select.textContent = `📁 ${folder.name}`;
      select.addEventListener("click", () => {
        currentFolderId = folder.id;
        renderFolders();
      });
      const count = document.createElement("small");
      const fileCount = files.filter(file => file.folderId === folder.id).length;
      count.textContent = fileCount === 1
        ? text("oneFile")
        : text("fileCount").replace("{count}", fileCount);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = text("delete");
      remove.addEventListener("click", () => deleteFolder(folder, files));
      card.append(select, count, remove);
      grid.append(card);
    });
    const selected = folders.find(folder => folder.id === currentFolderId);
    $("selectedFolderName").textContent = selected.name;
    renderStoredFiles(files.filter(file => file.folderId === currentFolderId));
  }).catch(showFilesError);
}

function renderStoredFiles(files) {
  previewUrls.forEach(url => URL.revokeObjectURL(url));
  previewUrls = [];
  const grid = $("storedFiles");
  grid.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = text("emptyFolder");
    grid.append(empty);
    return;
  }
  files.forEach(file => {
    const card = document.createElement("div");
    card.className = "stored-file";
    const title = document.createElement("strong");
    title.textContent = file.name;
    const details = document.createElement("small");
    details.textContent = `${file.type || "File"} · ${Math.ceil(file.size / 1024)} KB`;
    card.append(title, details);
    const url = URL.createObjectURL(file.blob);
    previewUrls.push(url);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = file.name;
      card.append(image);
    } else if (file.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      card.append(video);
    }
    const download = document.createElement("a");
    download.href = url;
    download.download = file.name;
    download.textContent = text("download");
    card.append(download);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = text("delete");
    remove.addEventListener("click", () => {
      storeRequest("files", "readwrite", store => store.delete(file.id))
        .then(renderFolders).catch(showFilesError);
    });
    card.append(remove);
    grid.append(card);
  });
}

function showFilesError(error) {
  $("filesError").textContent = `${text("storageError")} ${error.message || ""}`;
  $("filesError").hidden = false;
}

function deleteFolder(folder, files) {
  const transaction = database.transaction(["folders", "files"], "readwrite");
  transaction.objectStore("folders").delete(folder.id);
  files.filter(file => file.folderId === folder.id).forEach(file => {
    transaction.objectStore("files").delete(file.id);
  });
  transaction.oncomplete = renderFolders;
  transaction.onerror = () => showFilesError(transaction.error || new Error("Unable to delete folder."));
}

function playIncomingSound() {
  if (localStorage.getItem("bluebird-sound") === "off") return;
  try {
    audioContext = audioContext || new AudioContext();
    audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.25);
  } catch (error) {
    console.error("Could not play incoming message sound.", error);
  }
}

applyLanguage(language);
setAccountMode("signin");

$("signInMode").addEventListener("click", () => setAccountMode("signin"));
$("signUpMode").addEventListener("click", () => setAccountMode("signup"));
$("requireAppPinToggle").addEventListener("change", event => {
  saveProfilePreferences({ requirePin: event.target.checked });
});
$("appPinInput").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
});
$("appPinConfirmInput").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
});
$("pinRecoveryCodeInput").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
$("submitAppPin").addEventListener("click", submitAppPin);
$("appPinInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitAppPin();
  }
});
$("appPinConfirmInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitAppPin();
  }
});
$("forgotAppPinBtn").addEventListener("click", startPinRecovery);
$("verifyPinRecoveryBtn").addEventListener("click", verifyPinRecovery);
$("pinRecoveryCodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    verifyPinRecovery();
  }
});
$("pinSignOutBtn").addEventListener("click", signOutAccount);
$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("authEmail").value.trim().toLowerCase();
  const accounts = accountList();
  if (accountMode === "signup") {
    if (accounts.some(account => account.email === email)) {
      return showAuthError(text("emailAlreadyUsed"));
    }
    startEmailVerification({
      email,
      name: email.split("@")[0],
      provider: "email-demo",
      socialStats: { own: { followers: 0, friends: 0, views: 0, likes: 0 } }
    });
    return;
  }
  const account = accounts.find(item => item.email === email);
  if (!account) return showAuthError(text("accountMissing"));
  startEmailVerification(account, "signin");
});

$("verifyCode").addEventListener("click", verifyPendingEmail);
$("startAppBtn").addEventListener("click", () => {
  const button = $("startAppBtn");
  button.disabled = true;
  try {
    const accounts = accountList();
    const accountIndex = accounts.findIndex(item => item.email === currentAccount?.email);
    if (accountIndex < 0) throw new Error("The new account could not be found.");
    const account = { ...accounts[accountIndex], welcomePending: false };
    accounts[accountIndex] = account;
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
    currentAccount = account;
    $("firstWelcomeError").hidden = true;
    $("firstWelcomeDialog").close();
  } catch (error) {
    $("firstWelcomeError").textContent = `${text("storageError")} ${error.message || ""}`;
    $("firstWelcomeError").hidden = false;
    console.error("Could not save completion of the welcome screen.", error);
  } finally {
    button.disabled = false;
  }
});
$("verificationCode").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
$("verificationCode").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    verifyPendingEmail();
  }
});
$("resendCode").addEventListener("click", () => {
  if (pendingVerification) startEmailVerification(pendingVerification.account, pendingVerification.purpose);
});
$("cancelVerification").addEventListener("click", () => {
  const returningToProfile = pendingVerification?.purpose === "rename";
  pendingVerification = null;
  $("verificationStep").hidden = true;
  $("authEntry").hidden = false;
  if (returningToProfile) {
    $("authScreen").hidden = true;
    $("app").hidden = false;
    openEditProfile();
  } else {
    $("verificationPurposeNote").textContent = text("verificationDemo");
  }
});

document.querySelectorAll(".language-choice").forEach(button => {
  button.addEventListener("click", () => applyLanguage(button.dataset.language));
});
$("search").addEventListener("input", event => renderChats(event.target.value));
$("codeBtn").addEventListener("click", () => {
  $("profilePage").hidden = true;
  $("friendsView").hidden = true;
  $("filesView").hidden = true;
  $("codeStudio").hidden = false;
  $("app").classList.remove("profile-mode", "files-mode", "friends-mode");
  $("app").classList.add("code-mode");
  document.body.classList.remove("chat-open");
  updateLineNumbers();
});
$("backToChat").addEventListener("click", () => {
  $("codeStudio").hidden = true;
  $("app").classList.remove("code-mode");
});
$("languageSelect").addEventListener("change", updateCodeFileName);
$("codeEditor").value = localStorage.getItem("bluebird-code") || $("codeEditor").value;
updateLineNumbers();
$("codeEditor").addEventListener("input", () => {
  localStorage.setItem("bluebird-code", $("codeEditor").value);
  $("saveStatus").textContent = "Saved in this browser";
  updateLineNumbers();
});
$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("codeEditor").value);
    $("saveStatus").textContent = text("copied");
  } catch (error) {
    $("saveStatus").textContent = text("copyFailed");
    console.error("Could not copy code to clipboard.", error);
  }
});
$("downloadCode").addEventListener("click", () => {
  const blob = new Blob([$("codeEditor").value], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `main.${extensionByLanguage[$("languageSelect").value]}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("settingsBtn").addEventListener("click", () => {
  applyProfilePreferences();
  $("profileAbout").value = currentAccount.about || "";
  $("settingsDialog").showModal();
});
$("profileMenuBtn").addEventListener("click", () => {
  openEditProfile();
});
$("editProfilePageBtn").addEventListener("click", openEditProfile);
$("viewOwnProfileBtn").addEventListener("click", () => {
  $("profileDialog").close();
  openProfile(true);
});
$("closeProfile").addEventListener("click", () => $("profileDialog").close());
$("profileDialog").addEventListener("close", () => {
  if (!currentAccount) return;
  pendingProfileImage = currentAccount.profileImage || null;
  updateProfileAvatar();
});
$("profileImageUpload").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    $("profilePhotoError").textContent = text("imageTooLarge");
    $("profilePhotoError").hidden = false;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    $("profilePhotoError").textContent = text("imageTooLarge");
    $("profilePhotoError").hidden = false;
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingProfileImage = reader.result;
    $("profileImagePreview").src = pendingProfileImage;
    $("profileImagePreview").hidden = false;
    $("profileImagePlaceholder").hidden = true;
    $("profilePhotoError").hidden = true;
  };
  reader.onerror = () => {
    $("profilePhotoError").textContent = text("storageError");
    $("profilePhotoError").hidden = false;
  };
  reader.readAsDataURL(file);
});
$("postUpload").addEventListener("change", event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  if (currentAccount.preferences?.privacy !== "global") {
    pendingPostFiles = [];
    event.target.value = "";
    $("profilePostComposer").hidden = true;
    $("postError").textContent = text("postGlobalOnly");
    $("postError").hidden = false;
    return;
  }
  const invalidType = files.some(file => !file.type.startsWith("image/") && !file.type.startsWith("video/"));
  const oversized = files.some(file => file.size > 5 * 1024 * 1024);
  if (invalidType || oversized) {
    $("postError").textContent = text(oversized ? "postTooLarge" : "postMediaOnly");
    $("postError").hidden = false;
    event.target.value = "";
    pendingPostFiles = [];
    return;
  }
  pendingPostFiles = files;
  $("profilePostComposer").hidden = false;
  $("postError").hidden = true;
});
$("publishPostBtn").addEventListener("click", savePostFiles);
$("profileForm").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("profileDisplayName").value.trim();
  const accounts = accountList();
  $("profileNameError").hidden = true;
  if (name.length < 2 || name.length > 32) {
    $("profileNameError").textContent = text("invalidDisplayName");
    $("profileNameError").hidden = false;
    return;
  }
  const duplicate = accounts.some(account =>
    account.email !== currentAccount.email && String(account.name || "").trim().toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (duplicate) {
    $("profileNameError").textContent = text("duplicateDisplayName");
    $("profileNameError").hidden = false;
    return;
  }
  const updatedAccount = {
    ...currentAccount,
    name,
    profileImage: pendingProfileImage,
    preferences: {
      ...profilePreferences(),
      privacy: $("profilePrivacyMenu").value
    }
  };
  if (name !== currentAccount.name) {
    $("profileDialog").close();
    $("app").hidden = true;
    $("authScreen").hidden = false;
    $("authForm").reset();
    startEmailVerification(updatedAccount, "rename");
    return;
  }
  if (updatedAccount.preferences.privacy !== "global") {
    pendingPostFiles = [];
    $("postUpload").value = "";
    $("profilePostComposer").hidden = true;
  }
  const index = accounts.findIndex(account => account.email === currentAccount.email);
  if (index >= 0) accounts[index] = updatedAccount;
  try {
    await withAccountLoading("savingAccount", () => {
      localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
      currentAccount = updatedAccount;
      $("profileName").textContent = name;
      updateProfileAvatar();
      applyProfilePreferences();
      $("profileDialog").close();
      if (!$("profilePage").hidden && viewedProfile.own) openProfile(true, null, profilePageReturnMode, false);
    });
  } catch (error) {
    $("profilePhotoError").textContent = `${text("storageError")} ${error.message}`;
    $("profilePhotoError").hidden = false;
    console.error("Could not save the local account profile.", error);
  }
});
$("profilePrivacy").addEventListener("change", event => {
  saveProfilePreferences({ privacy: event.target.value });
  if (event.target.value !== "global") {
    pendingPostFiles = [];
    $("postUpload").value = "";
    $("profilePostComposer").hidden = true;
  }
  if (!$("profilePage").hidden && viewedProfile.own) openProfile(true, null, profilePageReturnMode, false);
});
$("profilePrivacyMenu").addEventListener("change", event => {
  $("profilePrivacy").value = event.target.value;
});
$("myMessageColor").addEventListener("input", event => saveProfilePreferences({ myMessageColor: event.target.value }));
$("friendMessageColor").addEventListener("input", event => saveProfilePreferences({ friendMessageColor: event.target.value }));
$("profileAbout").addEventListener("input", event => {
  currentAccount.about = event.target.value;
  const accounts = accountList();
  const index = accounts.findIndex(account => account.email === currentAccount.email);
  if (index >= 0) {
    accounts[index] = currentAccount;
    localStorage.setItem("bluebird-local-accounts", JSON.stringify(accounts));
  }
});
$("viewFriendProfileBtn").addEventListener("click", () => {
  if (contactActionsIndex === null) return;
  const index = contactActionsIndex;
  $("contactDialog").close();
  openProfile(false, index);
  contactActionsIndex = null;
});
$("friendVisibilityBtn").addEventListener("click", () => {
  if (contactActionsIndex === null) return;
  const chat = chats[contactActionsIndex];
  const state = readContactState();
  const hidden = Boolean(state[chat.name]?.profileHidden);
  state[chat.name] = { ...state[chat.name], profileHidden: !hidden };
  writeContactState(state);
  $("friendVisibilityBtn").textContent = text(hidden ? "hideFriendProfile" : "showFriendProfile");
  if (!$("profilePage").hidden && viewedProfile.chatIndex === contactActionsIndex) {
    openProfile(false, contactActionsIndex, profilePageReturnMode, false);
  }
});
$("backFromProfile").addEventListener("click", () => {
  setProfilePageMode(false);
  const viewedChat = chats[viewedProfile.chatIndex];
  const target = viewedProfile.own || viewedChat?.isAccountPreview ? activeChat : viewedProfile.chatIndex;
  if (target !== null && chats[target] && !readContactState()[chats[target].name]?.deleted) openChat(target);
});
$("profilePageBackBtn").addEventListener("click", () => $("backFromProfile").click());
$("followProfileBtn").addEventListener("click", () => {
  const chat = chats[viewedProfile.chatIndex];
  const stats = ensureProfileStats(false, chat);
  const wasFollowing = stats.following;
  updateViewedProfileStat("following", true);
  if (!wasFollowing) showContactToast(chat.name, chat.color, text("followedNotice").replace("{name}", chat.name));
});
$("simulateFollowerBtn").addEventListener("click", () => {
  if (!viewedProfile.own) return;
  updateViewedProfileStat("followers");
  showContactToast(text("newFollowerName"), "purple", text("newFollowerNotice"));
});
$("likeProfileBtn").addEventListener("click", () => updateViewedProfileStat("liked", true));
$("profileMoreBtn").addEventListener("click", () => {
  if (viewedProfile.chatIndex === null) return;
  contactActionsIndex = viewedProfile.chatIndex;
  $("contactDialogName").textContent = chats[contactActionsIndex].name;
  $("contactDialogAvatar").textContent = initials(chats[contactActionsIndex].name);
  $("contactDialogAvatar").className = `avatar ${chats[contactActionsIndex].color}`;
  const blocked = Boolean(readContactState()[chats[contactActionsIndex].name]?.blocked);
  $("blockFriendBtn").textContent = text(blocked ? "unblockFriend" : "blockFriend");
  $("blockFriendBtn").classList.toggle("is-blocked", !blocked);
  $("blockFriendBtn").classList.toggle("is-unblocked", blocked);
  $("friendVisibilityBtn").textContent = text(readContactState()[chats[contactActionsIndex].name]?.profileHidden
    ? "showFriendProfile" : "hideFriendProfile");
  $("contactDialog").showModal();
});
$("contactActionsBtn").addEventListener("click", openContactActions);
$("viewAccountProfileBtn").addEventListener("click", () => {
  if (!accountActionsEmail) return;
  const email = accountActionsEmail;
  $("accountActionsDialog").close();
  openAccountProfile(email);
});
$("addAccountFriendBtn").addEventListener("click", () => {
  if (accountActionsEmail) addAccountFriend(accountActionsEmail);
});
$("removeAccountFriendBtn").addEventListener("click", () => {
  if (accountActionsEmail) removeAccountFriend(accountActionsEmail);
});
$("blockAccountBtn").addEventListener("click", () => {
  if (accountActionsEmail) toggleAccountBlock(accountActionsEmail);
});
$("closeAccountActionsBtn").addEventListener("click", () => $("accountActionsDialog").close());
$("closeContactDialog").addEventListener("click", () => $("contactDialog").close());
$("createGroupBtn").addEventListener("click", openGroupDialog);
$("cancelGroupBtn").addEventListener("click", () => $("groupDialog").close());
$("groupForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("groupName").value.trim();
  const members = Array.from(new Set($("groupMembers").value.split(",").map(member => member.trim()).filter(Boolean)));
  if (!name) return;
  if (chats.some(chat => chat.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    $("groupError").textContent = text("groupExists");
    $("groupError").hidden = false;
    return;
  }
  $("groupError").hidden = true;
  createGroup(name, members);
  $("groupDialog").close();
});
$("openBotBtn").addEventListener("click", openBotChat);
$("blockFriendBtn").addEventListener("click", () => {
  if (contactActionsIndex === null) return;
  const chat = chats[contactActionsIndex];
  const state = readContactState();
  const blocked = Boolean(state[chat.name]?.blocked);
  state[chat.name] = { ...state[chat.name], blocked: !blocked };
  writeContactState(state);
  $("contactDialog").close();
  openChat(contactActionsIndex);
  showContactToast(
    chat.name,
    chat.color,
    text(blocked ? "unblockedStatus" : "blockedStatus").replace("{name}", chat.name)
  );
  contactActionsIndex = null;
});
$("removeFriendBtn").addEventListener("click", () => {
  if (contactActionsIndex === null) return;
  const chat = chats[contactActionsIndex];
  const state = readContactState();
  const wasDeleted = Boolean(state[chat.name]?.deleted);
  state[chat.name] = { ...state[chat.name], deleted: true };
  writeContactState(state);
  if (!wasDeleted && (chat.accountEmail || chat.isLocalFriend)) {
    const stats = { followers: 0, friends: 0, views: 0, likes: 0, ...(currentAccount.socialStats?.own || {}) };
    stats.friends = Math.max(0, stats.friends - 1);
    saveSocialStats({ ...socialStats(), own: stats });
  }
  $("contactDialog").close();
  showContactToast(chat.name, chat.color, text("removedStatus").replace("{name}", chat.name));
  contactActionsIndex = null;
  refreshActiveChatAfterRemoval();
});
$("simulateBlockBtn").addEventListener("click", () => {
  if (contactActionsIndex === null) return;
  const chat = chats[contactActionsIndex];
  $("contactDialog").close();
  showContactToast(chat.name, chat.color, text("blockedByStatus").replace("{name}", chat.name));
  contactActionsIndex = null;
});
$("closeToast").addEventListener("click", () => {
  clearTimeout(toastTimer);
  $("messageToast").hidden = true;
});
$("messageToast").addEventListener("click", event => {
  if (event.target.closest("#closeToast")) return;
  const toastName = $("toastName").textContent;
  const chatIndex = chats.findIndex(chat => chat.name === toastName);
  if (chatIndex >= 0 && !readContactState()[toastName]?.deleted) {
    $("messageToast").hidden = true;
    openChat(chatIndex);
  }
});
$("closeSettings").addEventListener("click", () => $("settingsDialog").close());
document.querySelectorAll(".theme-choice").forEach(button => {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
});
$("motionToggle").addEventListener("change", event => setReducedMotion(event.target.checked));
$("soundToggle").addEventListener("change", event => {
  localStorage.setItem("bluebird-sound", event.target.checked ? "on" : "off");
});
$("themeBtn").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  setReducedMotion(localStorage.getItem("bluebird-motion") === "off");
$("soundToggle").checked = localStorage.getItem("bluebird-sound") !== "off";

$("messageForm").addEventListener("submit", event => {
  event.preventDefault();
  const input = $("messageInput");
  const message = input.value.trim();
  if (!message) return;
  if (!chats[activeChat]) ensureNotesChat();
  const chat = chats[activeChat];
  const sendState = readContactState();
  if (!chat || sendState[chat.name]?.blocked || sendState[chat.name]?.deleted ||
    (chat.accountEmail && sendState.accountBlocks?.[chat.accountEmail])) return;
  chat.messages.push({
    text: message,
    mine: true,
    replyTo: pendingReply?.chatIndex === activeChat ? { text: pendingReply.text } : null
  });
  if (pendingReply?.chatIndex === activeChat) clearReplyTarget();
  chat.preview = message;
  saveChats();
  input.value = "";
  drawMessages();
  renderChats($("search").value);
  const replyingChat = activeChat;
  if (chat.isNotes) return;
  setTimeout(() => {
    const recipient = chats[replyingChat];
    const contactState = readContactState();
    const state = contactState[recipient.name];
    if (state?.blocked || state?.deleted || (recipient.accountEmail && contactState.accountBlocks?.[recipient.accountEmail])) return;
    const reply = recipient.isBot ? text("botReply") : text("incomingReply");
    recipient.messages.push({ text: reply, mine: false });
    recipient.preview = reply;
    saveChats();
    if (activeChat === replyingChat) drawMessages();
    renderChats($("search").value);
    showContactToast(recipient.name, recipient.color, text("wantsToTalk"));
  }, 1200);
});
$("cancelReplyBtn").addEventListener("click", clearReplyTarget);
$("messageUpload").addEventListener("change", event => {
  uploadMessageFiles(Array.from(event.target.files || []));
});
$("toggleMessageFilter").addEventListener("click", () => {
  $("messageFilter").hidden = !$("messageFilter").hidden;
  if (!$("messageFilter").hidden) $("messageFilterInput").focus();
  else {
    $("messageFilterInput").value = "";
    drawMessages();
  }
});
$("messageFilterInput").addEventListener("input", drawMessages);
$("clearMessageFilter").addEventListener("click", () => {
  $("messageFilterInput").value = "";
  drawMessages();
  $("messageFilterInput").focus();
});
$("blurMessageBtn").addEventListener("click", () => {
  if (!selectedMessage) return;
  const { chatIndex, messageIndex } = selectedMessage;
  const message = chats[chatIndex]?.messages[messageIndex];
  if (!message?.type?.startsWith("image/")) return;
  message.blurred = !message.blurred;
  saveChats();
  if (activeChat === chatIndex) drawMessages();
  $("messageActionsDialog").close();
});
$("deleteMessageBtn").addEventListener("click", deleteSelectedMessage);
$("downloadMessageBtn").addEventListener("click", () => {
  if (!selectedMessage) return;
  const message = chats[selectedMessage.chatIndex]?.messages[selectedMessage.messageIndex];
  if (!message?.attachmentId) return;
  $("messageActionsDialog").close();
  downloadMessageAttachment(message);
});
$("viewMessageMediaBtn").addEventListener("click", viewSelectedAttachment);
$("editMessageBtn").addEventListener("click", openMessageEditor);
$("saveEditedMessage").addEventListener("click", saveEditedMessage);
$("cancelEditMessage").addEventListener("click", () => $("editMessageDialog").close());
$("replyMessageBtn").addEventListener("click", () => {
  if (selectedMessage) setReplyTarget(selectedMessage.chatIndex, selectedMessage.messageIndex);
});
$("pinMessageBtn").addEventListener("click", () => {
  if (!selectedMessage) return;
  toggleMessagePin(selectedMessage.chatIndex, selectedMessage.messageIndex);
  $("messageActionsDialog").close();
});
$("filterMessageBtn").addEventListener("click", () => {
  if (!selectedMessage) return;
  const message = chats[selectedMessage.chatIndex]?.messages[selectedMessage.messageIndex];
  if (!message) return;
  $("messageFilter").hidden = false;
  $("messageFilterInput").value = message.text || message.name || "";
  $("messageActionsDialog").close();
  drawMessages();
  $("messageFilterInput").focus();
});
$("copyMessageBtn").addEventListener("click", async () => {
  if (!selectedMessage) return;
  const message = chats[selectedMessage.chatIndex]?.messages[selectedMessage.messageIndex];
  await copyPlainMessage(message);
});
$("closeMessageActions").addEventListener("click", () => $("messageActionsDialog").close());
$("closeMediaViewer").addEventListener("click", () => $("mediaViewerDialog").close());
$("mediaViewerDialog").addEventListener("close", () => {
  $("mediaViewerBody").replaceChildren();
  if (viewerMediaUrl) {
    URL.revokeObjectURL(viewerMediaUrl);
    viewerMediaUrl = null;
  }
});
$("mobileMenuToggle").addEventListener("click", toggleMobileMenu);
$("mobileMenuBackdrop").addEventListener("click", closeMobileMenu);
$("mobileNavigation").addEventListener("click", event => {
  if (event.target.closest("button, .chat-item")) closeMobileMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeMobileMenu();
});
window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 700px)").matches) closeMobileMenu();
});
$("backBtn").addEventListener("click", () => document.body.classList.remove("chat-open"));
$("signOutBtn").addEventListener("click", signOut);
$("signOutFilesBtn").addEventListener("click", signOut);
$("signOutCodeBtn").addEventListener("click", signOut);

$("filesBtn").addEventListener("click", () => {
  $("profilePage").hidden = true;
  $("friendsView").hidden = true;
  $("app").classList.add("files-mode");
  $("filesView").hidden = false;
  $("codeStudio").hidden = true;
  $("app").classList.remove("profile-mode", "code-mode", "friends-mode");
  document.body.classList.remove("chat-open");
  $("filesError").hidden = true;
  openDatabase().then(renderFolders).catch(showFilesError);
});
$("backFromFiles").addEventListener("click", () => {
  $("app").classList.remove("files-mode");
  $("filesView").hidden = true;
});
$("findFriendsBtn").addEventListener("click", () => {
  openFriendsCenter("search");
});
$("friendCenterBtn").addEventListener("click", () => openFriendsCenter("requests"));
$("nearbyFriendBtn").addEventListener("click", openNearbyFriendDialog);
$("closeNearbyFriendDialog").addEventListener("click", () => {
  stopNearbyFriendCamera();
  $("nearbyFriendDialog").close();
});
$("nearbyFriendDialog").addEventListener("close", stopNearbyFriendCamera);
$("copyNearbyFriendCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("nearbyFriendCode").value);
    showNearbyFriendStatus(text("friendQrCopied"));
  } catch (error) {
    showNearbyFriendStatus(`${text("copyFailed")} ${error.message || ""}`, true);
    console.error("Could not copy the nearby friend code.", error);
  }
});
$("scanNearbyFriendBtn").addEventListener("click", startNearbyFriendCamera);
$("nearbyFriendImage").addEventListener("change", event => {
  scanNearbyFriendImage(event.target.files?.[0]).finally(() => { event.target.value = ""; });
});
$("nearbyFriendCodeInput").addEventListener("input", event => {
  showNearbyFriendPreview(event.currentTarget.value);
});
$("acceptNearbyFriendBtn").addEventListener("click", () => {
  addNearbyFriend($("nearbyScannedCard").dataset.friendCode || $("nearbyFriendCodeInput").value);
});
$("blockNearbyFriendBtn").addEventListener("click", toggleNearbyFriendBlock);
$("dismissNearbyFriendBtn").addEventListener("click", () => {
  $("nearbyFriendCodeInput").value = "";
  $("nearbyScannedCard").hidden = true;
  $("nearbyFriendError").hidden = true;
  stopNearbyFriendCamera();
});
$("nearbyFriendCodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    showNearbyFriendPreview(event.currentTarget.value);
  }
});
document.querySelectorAll(".friend-center-tab").forEach(button => {
  button.addEventListener("click", () => {
    const section = button.dataset.friendSection;
    renderFriendCenter(section);
    if (section === "search") renderFriendSearchResults();
  });
});
$("friendSearchInput").addEventListener("input", event => {
  renderFriendSearchResults();
});
document.querySelectorAll(".friend-search-tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".friend-search-tab").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    renderFriendSearchResults();
  });
});
$("findCreateGroupBtn").addEventListener("click", () => {
  $("friendsView").hidden = true;
  $("app").classList.remove("friends-mode");
  openGroupDialog();
});
$("backFromFriends").addEventListener("click", () => {
  $("friendsView").hidden = true;
  $("app").classList.remove("friends-mode");
});
$("folderForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("folderName").value.trim();
  if (!name) return;
  const folder = { id: crypto.randomUUID(), name, ownerEmail: currentAccount.email };
  storeRequest("folders", "readwrite", store => store.add(folder))
    .then(() => {
      currentFolderId = folder.id;
      $("folderName").value = "";
      $("filesError").hidden = true;
      renderFolders();
    }).catch(showFilesError);
});
$("fileUpload").addEventListener("change", async event => {
  const selectedFiles = Array.from(event.target.files || []);
  if (!selectedFiles.length) return;
  try {
    if (!currentFolderId) {
      const folder = { id: crypto.randomUUID(), name: text("myFiles"), ownerEmail: currentAccount.email };
      await storeRequest("folders", "readwrite", store => store.add(folder));
      currentFolderId = folder.id;
    }
    const db = await openDatabase();
    const transaction = db.transaction("files", "readwrite");
    selectedFiles.forEach(file => transaction.objectStore("files").add({
      id: crypto.randomUUID(),
      folderId: currentFolderId,
      ownerEmail: currentAccount.email,
      name: file.name,
      type: file.type,
      size: file.size,
      blob: file
    }));
    transaction.oncomplete = () => {
      event.target.value = "";
      $("filesError").hidden = true;
      renderFolders();
    };
    transaction.onerror = () => showFilesError(transaction.error || new Error("Unable to save selected files."));
  } catch (error) {
    showFilesError(error);
  }
});

setTheme(localStorage.getItem("bluebird-theme") === "light" ? "light" : "dark");
const sessionEmail = localStorage.getItem("bluebird-session");
const activeAccount = accountList().find(account => account.email === sessionEmail);
if (activeAccount) {
  openAccountAccess(activeAccount)
    .catch(error => {
      if ($("pinDialog").open) {
        $("pinError").textContent = `${text("storageError")} ${error.message || ""}`;
        $("pinError").hidden = false;
      } else {
        showAuthError(`${text("storageError")} ${error.message || ""}`);
      }
      console.error("Could not restore or unlock the local account.", error);
    });
}
else {
  localStorage.removeItem("bluebird-session");
  $("app").hidden = true;
  $("authScreen").hidden = false;
}

window.addEventListener("online", updateOfflineScreen);
window.addEventListener("offline", updateOfflineScreen);
$("retryConnection").addEventListener("click", updateOfflineScreen);
updateOfflineScreen();

