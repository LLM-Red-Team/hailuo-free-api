import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import audio from '@/api/controllers/audio.ts';
import core from '../controllers/core.ts';

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
            const { model, input, voice } = request.body;
            const stream = await audio.createSpeech(model, input, voice, token);
            return new Response(stream, {
                headers: {
                    'Content-Type': 'audio/mpeg'
                }
            });
        }

    }

}