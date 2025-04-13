// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.

var system_prompt = `您是一個專注於提供展覽會場資訊的 AI 助手。
- 在調用函數之前，請根據現有的對話上下文回答查詢。
- 如果信息不明確或不可用，請查詢 get_information 以獲取準確的資訊。絕對不要編造答案。
- 在三句話內提供回應，強調簡潔和準確。
- 注意客戶在最新陳述中使用的語言，並使用相同的語言回應！`

// Update this value if you want to use a different voice
// const TTSVoice = "zh-CN-XiaochenMultilingualNeural"
const TTSVoice = "en-US-CoraMultilingualNeural"

// Fill your Azure cognitive services region here, e.g. westus2
const CogSvcRegion = "southeastasia"

const IceServerUrl = "turn:relay.communication.microsoft.com:3478" // Fill your ICE server URL here, e.g. turn:turn.azure.com:3478
let IceServerUsername
let IceServerCredential

const TalkingAvatarCharacter = "lisa"
// const TalkingAvatarCharacter = "Meg-formal"
// const TalkingAvatarCharacter = "Lori-graceful"
const TalkingAvatarStyle = "casual-sitting"
// const TalkingAvatarStyle = "business"
// The language detection engine supports a maximum of 4 languages
supported_languages = ["en-US", "zh-TW"]
let currentLang = "zh-TW"

let token
const suggestedQuestionKeys = {
  'en-US': ['introduceMicrosoft'],
  'zh-TW': ['introduceEvent', 'introduceTeams', 'copilotAgenda', 'introduceLiteon']
}
const i18nMap = {
  "en-US": {
    "headerTitle": "Copilot + AI Empowering the Future of Smart Work",
    "selectLanguage": "Please select a language",
    "assistantHelp": "Here are some tasks the virtual assistant can help you with:",
    // "introduceEvent": "Please introduce today's event",
    // "introduceTeams": "Please introduce Microsoft's Teams real-time interpretation feature",
    // "copilotAgenda": "What are the related sessions about Copilot today?",
    "introduceMicrosoft": "Please introduce Microsoft in 50 words",
    "login": {
      "usernamePlaceholder": "user@email.com",
      "passwordPlaceholder": "****************",
      "loginButton": "Login"
    },
    "micLabel": "Press the mic to start talking"
  },
  "zh-TW": {
    "headerTitle": "Copilot + AI 賦能 智慧工作新未來",
    "selectLanguage": "請選擇語言",
    "assistantHelp": "這裡有一些虛擬助理可以幫助你的事情:",
    "introduceEvent": "請介紹今日的活動",
    "introduceTeams": "請介紹微軟的Teams 即時口譯功能",
    "copilotAgenda": "請問關於Copilot的議題, 今日有哪些相關議程?",
    "introduceLiteon": "請用50個字介紹光寶科技",

    "login": {
      "usernamePlaceholder": "user@email.com",
      "passwordPlaceholder": "****************",
      "loginButton": "登入"
    },
    "micLabel": "按下麥克風開始說話"
  }
}

const getI18nConent = (key) => i18nMap[currentLang][key]

const speechSynthesisConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL("wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1?enableTalkingAvatar=true".replace("{region}", CogSvcRegion)))

// Global objects
var speechSynthesizer
var avatarSynthesizer
var peerConnection
var previousAnimationFrameTimestamp = 0
var sessionActive = false

messages = [{ "role": "system", "content": system_prompt }];

function removeDocumentReferences(str) {
  // Regular expression to match [docX]
  var regex = /\[doc\d+\]/g;

  // Replace document references with an empty string
  var result = str.replace(regex, '');

  return result;
}

// Setup WebRTC
function setupWebRTC() {
  // Create WebRTC peer connection
  fetch("/api/getIceServerToken", {
    method: "POST"
  })
    .then(async res => {
      const reponseJson = await res.json()
      peerConnection = new RTCPeerConnection({
        iceServers: [{
          urls: reponseJson["Urls"],
          username: reponseJson["Username"],
          credential: reponseJson["Password"]
        }]
      })

      // Fetch WebRTC video stream and mount it to an HTML video element
      peerConnection.ontrack = function (event) {
        console.log('peerconnection.ontrack', event)
        // Clean up existing video element if there is any
        remoteVideoDiv = document.getElementById('remoteVideo')
        for (var i = 0; i < remoteVideoDiv.childNodes.length; i++) {
          if (remoteVideoDiv.childNodes[i].localName === event.track.kind) {
            remoteVideoDiv.removeChild(remoteVideoDiv.childNodes[i])
          }
        }

        const videoElement = document.createElement(event.track.kind)
        videoElement.id = event.track.kind
        videoElement.srcObject = event.streams[0]
        videoElement.autoplay = true
        videoElement.controls = false
        document.getElementById('remoteVideo').appendChild(videoElement)

        canvas = document.getElementById('canvas')
        remoteVideoDiv.hidden = true
        canvas.hidden = false

        videoElement.addEventListener('play', () => {
          remoteVideoDiv.style.width = videoElement.videoWidth / 2 + 'px'
          window.requestAnimationFrame(makeBackgroundTransparent)
        })
      }

      // Make necessary update to the web page when the connection state changes
      peerConnection.oniceconnectionstatechange = e => {
        console.log("WebRTC status: " + peerConnection.iceConnectionState)

        if (peerConnection.iceConnectionState === 'connected') {
          document.getElementById('loginOverlay').classList.add("hidden");
        }

        if (peerConnection.iceConnectionState === 'disconnected') {
        }
      }

      // Offer to receive 1 audio, and 1 video track
      peerConnection.addTransceiver('video', { direction: 'sendrecv' })
      peerConnection.addTransceiver('audio', { direction: 'sendrecv' })

      // start avatar, establish WebRTC connection
      avatarSynthesizer.startAvatarAsync(peerConnection).then((r) => {
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
          console.log("[" + (new Date()).toISOString() + "] Avatar started. Result ID: " + r.resultId)
          greeting()
        } else {
          console.log("[" + (new Date()).toISOString() + "] Unable to start avatar. Result ID: " + r.resultId)
          if (r.reason === SpeechSDK.ResultReason.Canceled) {
            let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(r)
            if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
              console.log(cancellationDetails.errorDetails)
            };

            console.log("Unable to start avatar: " + cancellationDetails.errorDetails);
          }
        }
      }).catch(
        (error) => {
          console.log("[" + (new Date()).toISOString() + "] Avatar failed to start. Error: " + error)
          document.getElementById('startSession').disabled = false
          document.getElementById('configuration').hidden = false
        }
      )

    })
}

async function generateText(prompt) {

  messages.push({
    role: 'user',
    content: prompt,
    lang: currentLang
  });
  let generatedText
  let products
  await fetch(`/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messages) })
    .then(response => response.json())
    .then(data => {
      generatedText = data["messages"][data["messages"].length - 1].content;
      messages = data["messages"];
      products = data["products"]
    });

  addToConversationHistory(generatedText, 'light');
  if (products.length > 0) {
    addProductToChatHistory(products[0]);
  }
  return generatedText;
}

// Connect to TTS Avatar API
function connectToAvatarService() {
  // Construct TTS Avatar service request
  let videoCropTopLeftX = 600
  let videoCropBottomRightX = 1320
  let backgroundColor = '#00FF00FF'

  const videoFormat = new SpeechSDK.AvatarVideoFormat()
  videoFormat.setCropRange(new SpeechSDK.Coordinate(videoCropTopLeftX, 0), new SpeechSDK.Coordinate(videoCropBottomRightX, 1080));

  const avatarConfig = new SpeechSDK.AvatarConfig(TalkingAvatarCharacter, TalkingAvatarStyle, videoFormat)
  avatarConfig.backgroundColor = backgroundColor

  avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechSynthesisConfig, avatarConfig)
  avatarSynthesizer.avatarEventReceived = function (s, e) {
    var offsetMessage = ", offset from session start: " + e.offset / 10000 + "ms."
    if (e.offset === 0) {
      offsetMessage = ""
    }
    console.log("Event received: " + e.description + offsetMessage)
  }
  sessionActive = true
  console.log("Session State: " + sessionActive)
}

function disconnectAvatarService() {
  if (avatarSynthesizer !== undefined) {
      avatarSynthesizer.close()
  }

  if (speechRecognizer !== undefined) {
      speechRecognizer.stopContinuousRecognitionAsync()
      speechRecognizer.close()
  }

  sessionActive = false
  console.log("Session State: " + false)
}

window.startSession = () => {
  var iconElement = document.createElement("i");
  iconElement.className = "fa fa-spinner fa-spin";
  iconElement.id = "loadingIcon"
  var parentElement = document.getElementById("playVideo");
  parentElement.prepend(iconElement);

  speechSynthesisConfig.speechSynthesisVoiceName = TTSVoice
  document.getElementById('playVideo').className = "round-button-hide"

  fetch("/api/getSpeechToken", {
    method: "POST"
  })
    .then(response => response.text())
    .then(response => {
      speechSynthesisConfig.authorizationToken = response;
      token = response
    })
    .then(() => {
      speechSynthesizer = new SpeechSDK.SpeechSynthesizer(speechSynthesisConfig, null)
      connectToAvatarService()
      setupWebRTC()
    })
}

window.speak = (text) => {
  async function speak(text) {
    addToConversationHistory(text, 'dark')

    fetch("/api/detectLanguage?text=" + text, {
      method: "POST"
    })
      .then(response => response.text())
      .then(async language => {
        console.log(`Detected language: ${language}`);

        const generatedResult = await generateText(text);

        let spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='zh-CN-XiaochenMultilingualNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`

        if (language == 'ar-AE') {
          spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='ar-AE-FatimaNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`
        }
        let spokenText = generatedResult
        avatarSynthesizer.speakSsmlAsync(spokenTextssml, (result) => {
          if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("Speech synthesized to speaker for text [ " + spokenText + " ]. Result ID: " + result.resultId)
          } else {
            console.log("Unable to speak text. Result ID: " + result.resultId)
            if (result.reason === SpeechSDK.ResultReason.Canceled) {
              let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(result)
              console.log(cancellationDetails.reason)
              if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
                console.log(cancellationDetails.errorDetails)
              }
            }
          }
        })
      })
      .catch(error => {
        console.error('Error:', error);
      });
  }
  speak(text);
}

window.stopSession = () => {
  // speechSynthesizer.close()
  disconnectAvatarService()
}

window.startRecording = () => {
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, CogSvcRegion);
  speechConfig.authorizationToken = token;
  speechConfig.SpeechServiceConnection_LanguageIdMode = "Continuous";
  // var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(supported_languages);
  var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(["zh-TW"]);

  document.getElementById('buttonIcon').className = "fas fa-stop"
  document.getElementById('startRecording').disabled = true

  recognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig);

  recognizer.recognized = function (s, e) {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      console.log('Recognized:', e.result.text);
      window.stopRecording();
      // TODO: append to conversation
      window.speak(e.result.text);
    }
  };

  recognizer.startContinuousRecognitionAsync();

  console.log('Recording started.');
}

window.stopRecording = () => {
  if (recognizer) {
    recognizer.stopContinuousRecognitionAsync(
      function () {
        recognizer.close();
        recognizer = undefined;
        document.getElementById('buttonIcon').className = "fas fa-microphone"
        document.getElementById('startRecording').disabled = false
        console.log('Recording stopped.');
      },
      function (err) {
        console.error('Error stopping recording:', err);
      }
    );
  }
}

window.submitText = () => {
  document.getElementById('spokenText').textContent = document.getElementById('textinput').currentValue
  document.getElementById('textinput').currentValue = ""
  window.speak(document.getElementById('textinput').currentValue);
}


async function greeting() {
  addToConversationHistory("你好，我是 Lisa。請問有什麼需要協助的？", "light")

  let spokenText = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='zh-TW'><voice xml:lang='zh-TW' xml:gender='Female' name='zh-CN-XiaochenMultilingualNeural'>你好，我是 Lisa。請問有什麼需要協助的？</voice></speak>"
  avatarSynthesizer.speakSsmlAsync(spokenText, (result) => {
    if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      console.log("Speech synthesized to speaker for text [ " + spokenText + " ]. Result ID: " + result.resultId)
    } else {
      console.log("Unable to speak text. Result ID: " + result.resultId)
      if (result.reason === SpeechSDK.ResultReason.Canceled) {
        let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(result)
        console.log(cancellationDetails.reason)
        if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
          console.log(cancellationDetails.errorDetails)
        }
      }
    }
  })
}

function addToConversationHistory(item, historytype) {
  const list = document.getElementById('chathistory');
  const newItem = document.createElement('li');
  newItem.classList.add('message');
  newItem.classList.add(`message--${historytype}`);
  newItem.textContent = item;
  list.appendChild(newItem);
}

function addProductToChatHistory(product) {
  const list = document.getElementById('chathistory');
  const listItem = document.createElement('li');
  listItem.classList.add('product');
  listItem.innerHTML = `
    <fluent-card class="product-card">
      <div class="product-card__header">
        <img src="${product.image_url}" alt="tent" width="100%">
      </div>
    </fluent-card>
  `;
  list.appendChild(listItem);
}

// Make video background transparent by matting
function makeBackgroundTransparent(timestamp) {
  // Throttle the frame rate to 30 FPS to reduce CPU usage
  if (timestamp - previousAnimationFrameTimestamp > 30) {
    video = document.getElementById('video')
    tmpCanvas = document.getElementById('tmpCanvas')
    tmpCanvasContext = tmpCanvas.getContext('2d', { willReadFrequently: true })
    tmpCanvasContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight)
    if (video.videoWidth > 0) {
      let frame = tmpCanvasContext.getImageData(0, 0, video.videoWidth, video.videoHeight)
      for (let i = 0; i < frame.data.length / 4; i++) {
        let r = frame.data[i * 4 + 0]
        let g = frame.data[i * 4 + 1]
        let b = frame.data[i * 4 + 2]

        if (g - 150 > r + b) {
          // Set alpha to 0 for pixels that are close to green
          frame.data[i * 4 + 3] = 0
        } else if (g + g > r + b) {
          // Reduce green part of the green pixels to avoid green edge issue
          adjustment = (g - (r + b) / 2) / 3
          r += adjustment
          g -= adjustment * 2
          b += adjustment
          frame.data[i * 4 + 0] = r
          frame.data[i * 4 + 1] = g
          frame.data[i * 4 + 2] = b
          // Reduce alpha part for green pixels to make the edge smoother
          a = Math.max(0, 255 - adjustment * 4)
          frame.data[i * 4 + 3] = a
        }
      }

      canvas = document.getElementById('canvas')
      canvasContext = canvas.getContext('2d')
      canvasContext.putImageData(frame, 0, 0);
    }

    previousAnimationFrameTimestamp = timestamp
  }

  window.requestAnimationFrame(makeBackgroundTransparent)
}


function changeDocLang(language) {
  const languageSelect = document.getElementById('languageSelect');
  currentLang = language
  // Set the selected option
  for (const option of languageSelect.options) {
    option.selected = option.value === language;
  }
  updateContents()
}


function updateContents() {
  const questionsContainer = document.getElementById('suggestedQuestions')
  while (questionsContainer.firstChild) {
    questionsContainer.removeChild(questionsContainer.firstChild);
  }
  suggestedQuestionKeys[currentLang].forEach((key) => {
    const eleBtn = document.createElement('button')
    const content = getI18nConent(key)
    eleBtn.innerText = content
    eleBtn.onclick = () => window.speak(content);
    questionsContainer.appendChild(eleBtn)
  })
  // update header__title
  const headerTitle = document.getElementById('header_title')
  headerTitle.innerText = getI18nConent("headerTitle")
  // update headerTitle
  document.getElementById('headerTitle').innerText = getI18nConent("headerTitle")
  // update selectLanguage
  document.getElementById('selectLanguage').innerText = getI18nConent("selectLanguage")
  
  // update assistantHelp
  document.getElementById('assistantHelp').innerText = getI18nConent("assistantHelp")

  // update spokenText
  document.getElementById('spokenText').innerText = getI18nConent("micLabel")
}

function onDocLoaded() {
  updateContents()
}


