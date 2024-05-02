import { PassThrough } from "stream";
import http2, { ClientHttp2Session, ClientHttp2Stream } from "http2";
import path from "path";
import _ from "lodash";
import mime from "mime";
import FormData from "form-data";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "hailuo";
// 角色ID
const CHARACTER_ID = "1";
// 设备信息有效期
const DEVICE_INFO_EXPIRES = 10800;
// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Origin: "https://hailuoai.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  "Sec-Ch-Ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};
// 伪装数据
const FAKE_USER_DATA = {
  device_platform: "web",
  app_id: "3001",
  uuid: null,
  device_id: null,
  version_code: "21200",
  os_name: "Windows",
  browser_name: "chrome",
  server_version: "101",
  device_memory: 8,
  cpu_core_num: 16,
  browser_language: "zh-CN",
  browser_platform: "Win32",
  screen_width: 2560,
  screen_height: 1440,
  unix: null,
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// 设备信息映射
const deviceInfoMap = new Map();
// 设备信息请求队列映射
const deviceInfoRequestQueueMap: Record<string, Function[]> = {};

/**
 * 请求设备信息
 *
 * @param token 认证token
 */
async function requestDeviceInfo(token: string) {
  if (deviceInfoRequestQueueMap[token])
    return new Promise((resolve) =>
      deviceInfoRequestQueueMap[token].push(resolve)
    );
  deviceInfoRequestQueueMap[token] = [];
  logger.info(`Token: ${token}`);
  const result = await (async () => {
    const userId = util.uuid();
    const result = await request(
      "POST",
      "/v1/api/user/device/register",
      {
        uuid: userId,
      },
      token,
      {
        userId,
      }
    );
    const { deviceIDStr } = checkResult(result);
    return {
      deviceId: deviceIDStr,
      userId,
      refreshTime: util.unixTimestamp() + DEVICE_INFO_EXPIRES,
    };
  })()
    .then((result) => {
      if (deviceInfoRequestQueueMap[token]) {
        deviceInfoRequestQueueMap[token].forEach((resolve) => resolve(result));
        delete deviceInfoRequestQueueMap[token];
      }
      logger.success(`Refresh successful`);
      return result;
    })
    .catch((err) => {
      if (deviceInfoRequestQueueMap[token]) {
        deviceInfoRequestQueueMap[token].forEach((resolve) => resolve(err));
        delete deviceInfoRequestQueueMap[token];
      }
      return err;
    });
  if (_.isError(result)) throw result;
  return result;
}

/**
 * 获取缓存中的设备信息
 *
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 *
 * @param token 认证token
 */
async function acquireDeviceInfo(token: string): Promise<string> {
  let result = deviceInfoMap.get(token);
  if (!result) {
    result = await requestDeviceInfo(token);
    deviceInfoMap.set(token, result);
  }
  if (util.unixTimestamp() > result.refreshTime) {
    result = await requestDeviceInfo(token);
    deviceInfoMap.set(token, result);
  }
  return result;
}

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param token 认证token
 */
async function removeConversation(convId: string, token: string) {
  const deviceInfo = await acquireDeviceInfo(token);
  const result = await request(
    "DELETE",
    `/v1/api/chat/history/${convId}`,
    {},
    token,
    deviceInfo
  );
  checkResult(result);
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  messages: any[],
  token: string,
  refConvId = "",
  retryCount = 0
) {
  let session: ClientHttp2Session;
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, token))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9]{18}/.test(refConvId)) refConvId = "";

    // 请求流
    const deviceInfo = await acquireDeviceInfo(token);
    let stream: ClientHttp2Stream;
    ({ session, stream } = await requestStream(
      "POST",
      "/v4/api/chat/msg",
      messagesPrepare(messages, refs, refConvId),
      token,
      deviceInfo,
      {
        headers: {
          Accept: "text/event-stream",
          Referer: refConvId
            ? `https://hailuoai.com/?chat=${refConvId}`
            : "https://hailuoai.com/",
        }
      }
    ));

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(stream);
    session.close();
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话
    removeConversation(answer.id, token).catch(
      (err) => !refConvId && console.error(err)
    );

    return answer;
  })().catch((err) => {
    session && session.close();
    session = null;
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(messages, token, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  messages: any[],
  token: string,
  refConvId = "",
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, token))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9]{18}/.test(refConvId)) refConvId = "";

    // 请求流
    const deviceInfo = await acquireDeviceInfo(token);
    const result = await requestStream(
      "POST",
      "/v4/api/chat/msg",
      messagesPrepare(messages, refs, refConvId),
      token,
      deviceInfo,
      {
        headers: {
          Accept: "text/event-stream",
          Referer: refConvId
            ? `https://hailuoai.com/?chat=${refConvId}`
            : "https://hailuoai.com/",
        },
        responseType: "stream",
      }
    );

    if (result.headers["content-type"].indexOf("text/event-stream") == -1) {
      logger.error(
        `Invalid response Content-Type:`,
        result.headers["content-type"]
      );
      result.data.on("data", (buffer) => logger.error(buffer.toString()));
      const transStream = new PassThrough();
      transStream.end(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "服务暂时不可用，第三方响应错误",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return transStream;
    }

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(result.data, (convId: string) => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话
      removeConversation(convId, token).catch(
        (err) => !refConvId && console.error(err)
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          messages,
          token,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach((v) => {
      if (!_.isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      // glm-free-api支持格式
      if (
        v["type"] == "file" &&
        _.isObject(v["file_url"]) &&
        _.isString(v["file_url"]["url"])
      )
        urls.push(v["file_url"]["url"]);
      // 兼容gpt-4-vision-preview API格式
      else if (
        v["type"] == "image_url" &&
        _.isObject(v["image_url"]) &&
        _.isString(v["image_url"]["url"])
      )
        urls.push(v["image_url"]["url"]);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param refConvId 引用对话ID
 */
function messagesPrepare(messages: any[], refs: any[], refConvId: string) {
  let content;
  if (refConvId || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + (v["text"] || "") + "\n";
        }, content);
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n透传内容：\n" + content);
  } else {
    // 检查最新消息是否含有"type": "image_url"或"type": "file",如果有则注入消息
    let latestMessage = messages[messages.length - 1];
    let hasFileOrImage =
      Array.isArray(latestMessage.content) &&
      latestMessage.content.some(
        (v) =>
          typeof v === "object" && ["file", "image_url"].includes(v["type"])
      );
    if (hasFileOrImage) {
      let newFileMessage = {
        content: "关注用户最新发送文件和消息",
        role: "system",
      };
      messages.splice(messages.length - 1, 0, newFileMessage);
      logger.info("注入提升尾部文件注意力system prompt");
    } else {
      // 由于注入会导致设定污染，暂时注释
      // let newTextMessage = {
      //   content: "关注用户最新的消息",
      //   role: "system",
      // };
      // messages.splice(messages.length - 1, 0, newTextMessage);
      // logger.info("注入提升尾部消息注意力system prompt");
    }
    content = (
      messages.reduce((content, message) => {
        const role = message.role
          .replace("system", "<|sytstem|>")
          .replace("assistant", "<|assistant|>")
          .replace("user", "<|user|>");
        if (_.isArray(message.content)) {
          return message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (`${role}\n` + v["text"] || "") + "\n";
          }, content);
        }
        return (content += `${role}\n${message.content}\n`);
      }, "") + "<|assistant|>\n"
    )
      // 移除MD图像URL避免幻觉
      .replace(/\!\[.+\]\(.+\)/g, "")
      // 移除临时路径避免在新会话引发幻觉
      .replace(/\/mnt\/data\/.+/g, "");
    logger.info("\n对话合并：\n" + content);
  }

  const fileRefs = refs.filter((ref) => !ref.width && !ref.height);
  const imageRefs = refs
    .filter((ref) => ref.width || ref.height)
    .map((ref) => {
      ref.image_url = ref.file_url;
      return ref;
    });
  return {
    characterID: CHARACTER_ID,
    msgContent: content.trim(),
    chatID: refConvId || "0",
    searchMode: "0"
  };
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function uploadFile(fileUrl: string, refreshToken: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      // 60秒超时
      timeout: 60000,
    }));
  }

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);

  const formData = new FormData();
  formData.append("file", fileData, {
    filename,
    contentType: mimeType,
  });

  // 上传文件到目标OSS
  const token = await acquireDeviceInfo(refreshToken);
  let result = await axios.request({
    method: "POST",
    url: "https://chatglm.cn/chatglm/backend-api/assistant/file_upload",
    data: formData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 60秒超时
    timeout: 60000,
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: `https://chatglm.cn/`,
      ...FAKE_HEADERS,
      ...formData.getHeaders(),
    },
    validateStatus: () => true,
  });
  const { result: uploadResult } = checkResult(result);

  return uploadResult;
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { statusInfo, data } = result.data;
  if (!_.isObject(statusInfo)) return result.data;
  const { code, message } = statusInfo as any;
  if (code === 0) return data;
  throw new APIException(EX.API_REQUEST_FAILED, `[请求hailuo失败]: ${message}`);
}

/**
 * 从流接收完整的消息内容
 *
 * @param stream 消息流
 */
async function receiveStream(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        const eventName = event.event;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        console.log(eventName, result);
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let content = "";
  let toolCall = false;
  let codeGenerating = false;
  let textChunkLength = 0;
  let codeTemp = "";
  let lastExecutionOutput = "";
  let textOffset = 0;
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      if (result.status != "finish" && result.status != "intervene") {
        const text = result.parts.reduce((str, part) => {
          const { status, content, meta_data } = part;
          if (!_.isArray(content)) return str;
          const partText = content.reduce((innerStr, value) => {
            const {
              status: partStatus,
              type,
              text,
              image,
              code,
              content,
            } = value;
            if (partStatus == "init" && textChunkLength > 0) {
              textOffset += textChunkLength + 1;
              textChunkLength = 0;
              innerStr += "\n";
            }
            if (type == "text") {
              if (toolCall) {
                innerStr += "\n";
                textOffset++;
                toolCall = false;
              }
              if (partStatus == "finish") textChunkLength = text.length;
              return innerStr + text;
            } else if (
              type == "quote_result" &&
              status == "finish" &&
              meta_data &&
              _.isArray(meta_data.metadata_list)
            ) {
              const searchText =
                meta_data.metadata_list.reduce(
                  (meta, v) => meta + `检索 ${v.title}(${v.url}) ...`,
                  ""
                ) + "\n";
              textOffset += searchText.length;
              toolCall = true;
              return innerStr + searchText;
            } else if (
              type == "image" &&
              _.isArray(image) &&
              status == "finish"
            ) {
              const imageText =
                image.reduce(
                  (imgs, v) =>
                    imgs +
                    (/^(http|https):\/\//.test(v.image_url)
                      ? `![图像](${v.image_url || ""})`
                      : ""),
                  ""
                ) + "\n";
              textOffset += imageText.length;
              toolCall = true;
              return innerStr + imageText;
            } else if (type == "code" && partStatus == "init") {
              let codeHead = "";
              if (!codeGenerating) {
                codeGenerating = true;
                codeHead = "```python\n";
              }
              const chunk = code.substring(codeTemp.length, code.length);
              codeTemp += chunk;
              textOffset += codeHead.length + chunk.length;
              return innerStr + codeHead + chunk;
            } else if (
              type == "code" &&
              partStatus == "finish" &&
              codeGenerating
            ) {
              const codeFooter = "\n```\n";
              codeGenerating = false;
              codeTemp = "";
              textOffset += codeFooter.length;
              return innerStr + codeFooter;
            } else if (
              type == "execution_output" &&
              _.isString(content) &&
              partStatus == "done" &&
              lastExecutionOutput != content
            ) {
              lastExecutionOutput = content;
              textOffset += content.length + 1;
              return innerStr + content + "\n";
            }
            return innerStr;
          }, "");
          return str + partText;
        }, "");
        const chunk = text.substring(content.length - textOffset, text.length);
        if (chunk) {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: result.conversation_id,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null },
            ],
            created,
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        const data = `data: ${JSON.stringify({
          id: result.conversation_id,
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta:
                result.status == "intervene" &&
                result.last_error &&
                result.last_error.intervene_text
                  ? { content: `\n\n${result.last_error.intervene_text}` }
                  : {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        content = "";
        endCallback && endCallback(result.conversation_id);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 发起请求
 *
 * @param method 请求方法
 * @param uri 请求uri
 * @param data 请求数据
 * @param token 认证token
 * @param deviceInfo 设备信息
 * @param options 请求选项
 */
async function request(
  method: string,
  uri: string,
  data: any,
  token: string,
  deviceInfo: any,
  options: AxiosRequestConfig = {}
) {
  const unix = `${Date.parse(new Date().toString())}`;
  const userData = _.clone(FAKE_USER_DATA);
  userData.uuid = deviceInfo.userId;
  userData.device_id = deviceInfo.deviceId || undefined;
  userData.unix = unix;
  let queryStr = "";
  for (let key in userData) {
    if (_.isUndefined(userData[key])) continue;
    queryStr += `&${key}=${userData[key]}`;
  }
  queryStr = queryStr.substring(1);
  const dataJson = JSON.stringify(data || {});
  const yy = util.md5(
    encodeURIComponent(`${uri}?${queryStr}_${dataJson}${util.md5(unix)}ooui`)
  );
  return await axios.request({
    method,
    url: `https://hailuoai.com${uri}?${queryStr}`,
    data,
    timeout: 15000,
    validateStatus: () => true,
    ...options,
    headers: {
      Referer: "https://hailuoai.com/",
      Token: token,
      ...FAKE_HEADERS,
      ...(options.headers || {}),
      Yy: yy,
    },
  });
}

/**
 * 发起HTTP2.0流式请求
 *
 * @param method 请求方法
 * @param uri 请求uri
 * @param data 请求数据
 * @param token 认证token
 * @param deviceInfo 设备信息
 * @param options 请求选项
 */
async function requestStream(
  method: string,
  uri: string,
  data: any,
  token: string,
  deviceInfo: any,
  options: AxiosRequestConfig = {}
) {
  const unix = `${Date.parse(new Date().toString())}`;
  const userData = _.clone(FAKE_USER_DATA);
  userData.uuid = deviceInfo.userId;
  userData.device_id = deviceInfo.deviceId || undefined;
  userData.unix = unix;
  let queryStr = "";
  for (let key in userData) {
    if (_.isUndefined(userData[key])) continue;
    queryStr += `&${key}=${userData[key]}`;
  }
  queryStr = queryStr.substring(1);
  const formData = new FormData();
  for (let key in data) formData.append(key, data[key]);
  const dataJson = `${util.md5(data.characterID)}${util.md5(
    data.msgContent
  )}${util.md5(data.chatID)}${util.md5("")}`;
  data = formData;
  const yy = util.md5(
    encodeURIComponent(`${uri}?${queryStr}_${dataJson}${util.md5(unix)}ooui`)
  );
  const session: ClientHttp2Session = await new Promise(
    (resolve, reject) => {
      const session = http2.connect("https://hailuoai.com");
      session.on("connect", () => resolve(session));
      session.on("error", reject);
    }
  );
  
  const stream = session.request({
    ":method": method,
    ":path": `${uri}?${queryStr}`,
    ":scheme": "https",
    Referer: "https://hailuoai.com/",
    Token: token,
    ...FAKE_HEADERS,
    ...(options.headers || {}),
    Yy: yy,
    ...data.getHeaders()
  });
  stream.setTimeout(120000);
  stream.setEncoding("utf8");
  stream.end(data.getBuffer());

  return {
    session,
    stream
  };
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(token: string) {
  return false;
}

export default {
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
};
