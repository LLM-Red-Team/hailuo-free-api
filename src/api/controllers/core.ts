import http2, { ClientHttp2Session } from "http2";
import path from "path";
import fs from "fs";
import _ from "lodash";
import mime from "mime";
import FormData from "form-data";
import OSS from "ali-oss";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 设备信息有效期
const DEVICE_INFO_EXPIRES = 10800;
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
 * @param token 认证token
 */
async function uploadFile(fileUrl: string, token: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData: Buffer, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = `${util.uuid()}${path.extname(fileUrl)}`;
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

  const deviceInfo = await acquireDeviceInfo(token);

  // 获取文件上传策略
  const policyResult = await request(
    "GET",
    "/v1/api/files/request_policy",
    {},
    token,
    deviceInfo
  );
  const {
    accessKeyId,
    accessKeySecret,
    bucketName,
    dir,
    endpoint,
    securityToken,
  } = checkResult(policyResult);

  // 上传文件到OSS
  const client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket: bucketName,
    endpoint,
    stsToken: securityToken,
  });
  await client.put(`${dir}/${filename}`, fileData);

  // 上传回调
  const policyCallbackResult = await request(
    "POST",
    "/v1/api/files/policy_callback",
    {
      fileName: filename,
      originFileName: filename,
      dir,
      endpoint: endpoint,
      bucketName,
      size: `${fileData.byteLength}`,
      mimeType,
    },
    token,
    deviceInfo
  );
  const { fileID } = checkResult(policyCallbackResult);

  const isImage = [
    "image/jpeg",
    "image/jpg",
    "image/tiff",
    "image/png",
    "image/bmp",
    "image/gif",
    "image/svg+xml",
    "image/webp",
    "image/ico",
    "image/heic",
    "image/heif",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/x-png",
  ].includes(mimeType);

  return {
    fileType: isImage ? 2 : 6,
    filename,
    fileId: fileID,
  };
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
  const fullUri = `${uri}${uri.lastIndexOf("?") != -1 ? "&" : "?"}${queryStr}`;
  const yy = util.md5(
    `${encodeURIComponent(fullUri)}_${dataJson}${util.md5(unix)}ooui`
  );
  return await axios.request({
    method,
    url: `https://hailuoai.com${fullUri}`,
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
  for (let key in data) {
    if (!data[key]) continue;
    if (_.isBuffer(data[key])) {
      formData.append(key, data[key], {
        filename: "audio.mp3",
        contentType: "audio/mp3",
      });
    } else formData.append(key, data[key]);
  }
  let dataJson = "";
  if (data.msgContent)
    dataJson = `${util.md5(data.characterID)}${util.md5(
      data.msgContent.replace(/(\r\n|\n|\r)/g, "")
    )}${util.md5(data.chatID)}${util.md5(data.form ? data.form : "")}`;
  else if (data.voiceBytes)
    dataJson = `${util.md5(data.characterID)}${util.md5(data.chatID)}${util.md5(
      data.voiceBytes.subarray(0, 1024)
    )}`;
  data = formData;
  const yy = util.md5(
    encodeURIComponent(`${uri}?${queryStr}`) +
      `_${dataJson}${util.md5(unix)}ooui`
  );
  const session: ClientHttp2Session = await new Promise((resolve, reject) => {
    const session = http2.connect("https://hailuoai.com");
    session.on("connect", () => resolve(session));
    session.on("error", reject);
  });

  const stream = session.request({
    ":method": method,
    ":path": `${uri}?${queryStr}`,
    ":scheme": "https",
    Referer: "https://hailuoai.com/",
    Token: token,
    ...FAKE_HEADERS,
    ...(options.headers || {}),
    Yy: yy,
    ...data.getHeaders(),
  });
  stream.setTimeout(120000);
  stream.setEncoding("utf8");
  stream.end(data.getBuffer());
  return {
    session,
    stream,
  };
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(token: string) {
  const deviceInfo = await acquireDeviceInfo(token);
  const result = await request(
    "GET",
    "/v1/api/user/info",
    {},
    token,
    deviceInfo
  );
  try {
    const { userInfo } = checkResult(result);
    return _.isObject(userInfo);
  } catch (err) {
    deviceInfoMap.delete(token);
    return false;
  }
}

export default {
  acquireDeviceInfo,
  request,
  requestStream,
  checkResult,
  checkFileUrl,
  uploadFile,
  tokenSplit,
  getTokenLiveStatus,
};
