import { PassThrough } from "stream";
import { ClientHttp2Session, ClientHttp2Stream } from "http2";
import _ from "lodash";

import { createParser } from "eventsource-parser";
import core from "./core.ts";
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

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param token 认证token
 */
async function removeConversation(convId: string, token: string) {
  const deviceInfo = await core.acquireDeviceInfo(token);
  const result = await core.request(
    "DELETE",
    `/v1/api/chat/history/${convId}`,
    {},
    token,
    deviceInfo
  );
  core.checkResult(result);
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
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
        refFileUrls.map((fileUrl) => core.uploadFile(fileUrl, token))
      )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9]{18}/.test(refConvId)) refConvId = "";

    // 请求流
    const deviceInfo = await core.acquireDeviceInfo(token);

    let stream: ClientHttp2Stream;
    ({ session, stream } = await core.requestStream(
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
      }
    ));

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, stream);
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
        return createCompletion(
          model,
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
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
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
        refFileUrls.map((fileUrl) => core.uploadFile(fileUrl, token))
      )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9]{18}/.test(refConvId)) refConvId = "";

    // 请求流
    const deviceInfo = await core.acquireDeviceInfo(token);
    let stream: ClientHttp2Stream;
    ({ session, stream } = await core.requestStream(
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
      }
    ));

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, stream, (convId: string) => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话
      removeConversation(convId, token).catch(
        (err) => !refConvId && console.error(err)
      );
    });
  })().catch((err) => {
    session && session.close();
    session = null;
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
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
 * 同步复述对话补全
 *
 * @param model 模型名称
 * @param content 复述内容
 * @param token 认证token
 * @param retryCount 重试次数
 */
async function createRepeatCompletion(
  model = MODEL_NAME,
  content: string,
  token: string,
  retryCount = 0
) {
  let session: ClientHttp2Session;
  return (async () => {
    // 请求流
    const deviceInfo = await core.acquireDeviceInfo(token);
    let stream: ClientHttp2Stream;
    ({ session, stream } = await core.requestStream(
      "POST",
      "/v4/api/chat/msg",
      messagesPrepare([
        {
          role: "user",
          content: `user:完整复述以下内容，不要进行任何修改，也不需要进行任何解释，输出结果使用【】包裹。\n【${content}。】\nassistant:好的，我将开始完整复述：\n【`,
        },
      ]),
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
    const answer = await receiveStream(model, stream, true);
    session.close();

    logger.info(`\n复述结果：\n${answer.choices[0].message.content}`);

    return answer;
  })().catch((err) => {
    session && session.close();
    session = null;
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createRepeatCompletion(model, content, token, retryCount + 1);
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
function messagesPrepare(
  messages: any[],
  refs: any[] = [],
  refConvId?: string
) {
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
        if (_.isArray(message.content)) {
          return message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + `${message.role}:${v["text"] || ""}` + "\n";
          }, content);
        }
        return (content += `${message.role}:${message.content}\n`);
      }, "") + "assistant:\n"
    )
      .trim()
      // 移除MD图像URL避免幻觉
      .replace(/\!\[.+\]\(.+\)/g, "");
    logger.info("\n对话合并：\n" + content);
  }
  return {
    characterID: CHARACTER_ID,
    msgContent: content,
    chatID: refConvId || "0",
    searchMode: "0",
    form:
      refs.length > 0
        ? JSON.stringify([
          ...refs.map((item) => ({
            name: "",
            formType: item.fileType,
            content: item.filename,
            fileID: item.fileId,
          })),
          { name: "", formType: 1, content },
        ])
        : undefined,
  };
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param stream 消息流
 */
async function receiveStream(
  model: string,
  stream: any,
  message_id_required?: boolean
): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model,
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
      message_id: message_id_required ? "" : undefined,
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        const eventName = event.event;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        const { type, statusInfo, data: _data } = result;
        const { code, message } = statusInfo || {};
        if (code !== 0 && type != 3)
          throw new Error(`Stream response error: ${message}`);
        const { messageResult } = _data || {};
        if (eventName == "message_result" && messageResult) {
          const { chatID, msgID, isEnd, content, extra } = messageResult;
          // const { netSearchStatus } = extra || {};
          // const { linkDetail } = netSearchStatus || [];
          if (!data.id) data.id = chatID;
          if (message_id_required && !data.message_id) data.message_id = msgID;
          const exceptCharIndex = content.indexOf("�");
          const chunk = content.substring(
            exceptCharIndex != -1
              ? Math.min(
                data.choices[0].message.content.length,
                exceptCharIndex
              )
              : data.choices[0].message.content.length,
            exceptCharIndex == -1 ? content.length : exceptCharIndex
          );
          data.choices[0].message.content += chunk;
          // if(isEnd === 0 && linkDetail.length) {
          //   const refContent = linkDetail.reduce((str, item) => str + (item.url ? `${item.detail || '未知来源'} - ${item.url}\n` : ''), '');
          //   data.choices[0].message.content += `\n\n搜索结果来自：\n${refContent}`;
          // }
        }
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
 * @param model 模型名称
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(model: string, stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let convId = "";
  let content = "";
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model,
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
      const eventName = event.event;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const { type, statusInfo, data: _data } = result;
      const { code, message } = statusInfo || {};
      if (code !== 0 && type != 3)
        throw new Error(`Stream response error: ${message}`);
      const { messageResult } = _data || {};
      if (eventName == "message_result" && messageResult) {
        const { chatID, isEnd, content: text, extra } = messageResult;
        if (isEnd !== 0 && !text) return;
        if (!convId) convId = chatID;
        const exceptCharIndex = text.indexOf("�");
        const chunk = text.substring(
          exceptCharIndex != -1
            ? Math.min(content.length, exceptCharIndex)
            : content.length,
          exceptCharIndex == -1 ? text.length : exceptCharIndex
        );
        content += chunk;
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { content: chunk },
              finish_reason: isEnd === 0 ? "stop" : null,
            },
          ],
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        if (isEnd === 0) {
          !transStream.closed && transStream.end("data: [DONE]\n\n");
          endCallback && endCallback(chatID);
        }
      }
    } catch (err) {
      logger.error(err);
      if (!transStream.closed) {
        transStream.write(
          `data: ${JSON.stringify({
            id: convId,
            model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  content: err.message.replace("Stream response error: ", ""),
                },
                finish_reason: "stop",
              },
            ],
            created,
          })}\n\n`
        );
        transStream.end("data: [DONE]\n\n");
      }
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

export default {
  createCompletion,
  createCompletionStream,
  createRepeatCompletion,
  removeConversation,
};
