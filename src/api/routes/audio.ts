import _ from "lodash";
import fs from "fs-extra";
import mime from "mime";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import audio from "@/api/controllers/audio.ts";
import modelMap from "../consts/model-map.ts";
import environment from "@/lib/environment.ts";
import core from "../controllers/core.ts";
import logger from "@/lib/logger.ts";

const REPLACE_AUDIO_MODEL_ENV = (
  environment.envVars["REPLACE_AUDIO_MODEL"] || ""
)
  .split(",")
  .map((v) => v.trim());
const VOICE_TO_MODEL_INDEX = Object.keys(modelMap["tts-1"]).reduce(
  (obj, key, i) => {
    obj[key] = i;
    return obj;
  },
  {}
);
const REPLACE_AUDIO_MODEL = Object.values(modelMap["tts-1"]).map(
  (v, i) => REPLACE_AUDIO_MODEL_ENV[i] || v
);

export default {
  prefix: "/v1/audio",

  post: {
    "/speech": async (request: Request) => {
      request
        .validate("body.input", _.isString)
        .validate("body.voice", _.isString)
        .validate("headers.authorization", _.isString);
      // token切分
      const tokens = core.tokenSplit(request.headers.authorization);
      // 随机挑选一个token
      const token = _.sample(tokens);
      let { model, input, voice } = request.body;
      if (voice in VOICE_TO_MODEL_INDEX) {
        voice =
          REPLACE_AUDIO_MODEL[VOICE_TO_MODEL_INDEX[voice]] || "male-botong";
        logger.info(`请求voice切换为: ${voice}`);
      }
      const stream = await audio.createSpeech(model, input, voice, token);
      return new Response(stream, {
        headers: {
          "Content-Type": "audio/mpeg",
        },
      });
    },

    "/transcriptions": async (request: Request) => {
      request
        .validate("body.model", _.isString)
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("headers.authorization", _.isString);
      // token切分
      const tokens = core.tokenSplit(request.headers.authorization);
      // 随机挑选一个token
      const token = _.sample(tokens);
      if(!request.files['file'])
        throw new Error('File field is not set');
      const file = request.files['file'];
      if(!['audio/mp3', 'audio/mpeg', 'audio/x-wav', 'audio/wave', 'audio/mp4a-latm', 'audio/flac', 'audio/ogg', 'audio/webm'].includes(file.mimetype))
        throw new Error(`File MIME type ${file.mimetype} is unsupported`);
      const ext = mime.getExtension(file.mimetype);
      const tmpFilePath = `tmp/${file.newFilename}.${ext == 'mpga' ? 'mp3' : ext}`;
      await fs.copy(file.filepath, tmpFilePath);
      const { model, response_format: responseFormat = 'json' } = request.body;
      const text = await audio.createTranscriptions(model, tmpFilePath, token);
      return new Response(responseFormat == 'json' ? { text } : text);
    },
  },
};
