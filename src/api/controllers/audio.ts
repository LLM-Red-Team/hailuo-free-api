import path from 'path';
import { ClientHttp2Session, ClientHttp2Stream } from "http2";
import _ from "lodash";
import fs from "fs-extra";
import axios from "axios";
import { createParser } from "eventsource-parser";
import AsyncLock from "async-lock";

import core from "./core.ts";
import chat from "./chat.ts";
import modelMap from "../consts/model-map.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "hailuo";
// 角色ID
const CHARACTER_ID = "1";
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;

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
  const answer = await chat.createRepeatCompletion(
    model,
    input.replace(/\n/g, "。"),
    token
  );
  const { id: convId, message_id: messageId } = answer;

  const deviceInfo = await core.acquireDeviceInfo(token);

  // OpenAI模型映射转换
  if (modelMap[model]) voice = modelMap[model][voice] || voice;

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

async function createTranscriptions(
  model = MODEL_NAME,
  filePath: string,
  token: string,
  retryCount = 0
) {
  const name = path.basename(filePath).replace(path.extname(filePath), '');
  const transcodedFilePath = `tmp/${name}_transcodeed.mp3`;
  await util.transAudioCode(filePath, transcodedFilePath);
  const buffer = await fs.readFile(transcodedFilePath);
  fs.remove(transcodedFilePath)
    .catch(err => logger.error('移除临时文件失败：', err));
  let session: ClientHttp2Session;
  return (async () => {
    // 请求流
    const deviceInfo = await core.acquireDeviceInfo(token);
    let stream: ClientHttp2Stream;
    ({ session, stream } = await core.requestStream(
      "POST",
      "/v1/api/chat/phone_msg",
      {
        chatID: "0",
        voiceBytes: buffer,
        characterID: CHARACTER_ID,
        playSpeedLevel: "1",
      },
      token,
      deviceInfo,
      {
        headers: {
          Accept: "text/event-stream",
          Referer: "https://hailuoai.com/",
        },
      }
    ));

    // 接收流为输出文本
    const text = await receiveTrasciptionResult(stream);
    session.close();
    
    return text;
  })().catch((err) => {
    session && session.close();
    session = null;
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createTranscriptions(model, filePath, token, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 从流接收转写结果
 *
 * @param stream 响应流
 */
async function receiveTrasciptionResult(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let text = "";
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        const { status_code, err_message, data } = result;
        if(status_code == 1200041) {
          resolve("");
          stream.close();
          return;
        }
        if(status_code != 0)
          throw new Error(`Stream response error: ${err_message}`);
        if (event.event == "asr_chunk") {
          resolve(data.text);
          stream.close();
        }
        // 目前首个asr_chunk就可以获得完整的文本，如果有变动再启用下面这个代替它
        // if (event.event == "asr_chunk")
        //   text += data.text;
        // else if (event.event == "audio_chunk") {
        //   resolve(text);
        //   stream.close();
        // }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(text));
  });
}

export default {
  createSpeech,
  createTranscriptions,
};
