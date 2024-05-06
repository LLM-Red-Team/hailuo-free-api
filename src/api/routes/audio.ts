import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import audio from '@/api/controllers/audio.ts';
import core from '../controllers/core.ts';
import logger from "@/lib/logger.ts";

const voiceToModelIndex = {
    "alloy": 0,
    "echo": 1,
    "fable": 2,
    "onyx": 3,
    "nova": 4,
    "shimmer": 5
};

export default {

    prefix: '/v1/audio',

    post: {

        '/speech': async (request: Request) => {
            request
                .validate('body.input', _.isString)
                .validate('body.voice', _.isString)
                .validate('headers.authorization', _.isString)
            // token切分
            const tokens = core.tokenSplit(request.headers.authorization);
            // 随机挑选一个token
            const token = _.sample(tokens);
            let { model, input, voice } = request.body;
            logger.info(`请求model: ${model}, input: ${input}, voice: ${voice}`);
            if (voice in voiceToModelIndex){
                voice = process.env.REPLACE_AUDIO_MODEL[voiceToModelIndex[voice]];
                logger.info(`请求voice切换为: ${voice}`);
            }
            const stream = await audio.createSpeech(model, input, voice, token);
            return new Response(stream, {
                headers: {
                    'Content-Type': 'audio/mpeg'
                }
            });
        }

    }

}