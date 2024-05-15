import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import audio from "@/api/controllers/audio.ts";
import modelMap from "../consts/model-map.ts";
import environment from "@/lib/environment.ts";
import core from "../controllers/core.ts";
import logger from "@/lib/logger.ts";

const REPLACE_AUDIO_MODEL_ENV = (environment.envVars['REPLACE_AUDIO_MODEL'] || '').split(",").map((v) => v.trim());
const VOICE_TO_MODEL_INDEX = Object.keys(modelMap["tts-1"]).reduce(
  (obj, key, i) => {
    obj[key] = i;
    return obj;
  },
  {}
);
const REPLACE_AUDIO_MODEL = Object.values(modelMap["tts-1"]).map((v, i) => REPLACE_AUDIO_MODEL_ENV[i] || v);

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
  },
};
