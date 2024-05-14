import _ from "lodash";
import axios from "axios";
import AsyncLock from "async-lock";

import core from "./core.ts";
import chat from "./chat.ts";
import modelMap from "../consts/model-map.ts";

// 模型名称
const MODEL_NAME = "hailuo";

// 语音生成异步锁
const voiceLock = new AsyncLock();

/**
 * 创建语音
 *
 * @param model 模型名称
 * @param input 语音内容
 * @param voice 发音人
 */
async function createSpeech(
  model = MODEL_NAME,
  input: string,
  voice: string,
  token: string
) {
  // 先由hailuo复述语音内容获得会话ID和消息ID
  const answer = await chat.createRepeatCompletion(model, input.replace(/\n/g, '。'), token);
  const { id: convId, message_id: messageId } = answer;

  const deviceInfo = await core.acquireDeviceInfo(token);

  // OpenAI模型映射转换
  if(modelMap[model])
    voice = modelMap[model][voice] || voice;

  const audioUrls = await voiceLock.acquire(token, async () => {
    // 请求切换发音人
    const result = await core.request(
      "POST",
      "/v1/api/chat/update_robot_custom_config",
      {
        robotID: "1",
        config: { robotVoiceID: voice },
      },
      token,
      deviceInfo
    );
    core.checkResult(result);

    // 请求生成语音
    let requestStatus = 0,
      audioUrls = [];
    let startTime = Date.now();
    while (requestStatus < 2) {
      if (Date.now() - startTime > 30000) throw new Error("语音生成超时");
      const result = await core.request(
        "GET",
        `/v1/api/chat/msg_tts?msgID=${messageId}&timbre=${voice}`,
        {},
        token,
        deviceInfo
      );
      ({ requestStatus, result: audioUrls } = core.checkResult(result));
    }
    return audioUrls;
  });

  // 移除对话
  await chat.removeConversation(convId, token);

  if (audioUrls.length == 0) throw new Error("语音未生成");

  // 请求下载流
  const downloadResults = await Promise.all(
    audioUrls.map((url) =>
      axios.get(url, {
        headers: {
          Referer: "https://hailuoai.com/",
        },
        timeout: 30000,
        responseType: "arraybuffer",
      })
    )
  );
  let audioBuffer = Buffer.from([]);
  for (let result of downloadResults) {
    if (result.status != 200)
      throw new Error(`语音下载失败：[${result.status}]${result.statusText}`);
    audioBuffer = Buffer.concat([audioBuffer, result.data]);
  }
  return audioBuffer;
}

export default {
  createSpeech,
};
