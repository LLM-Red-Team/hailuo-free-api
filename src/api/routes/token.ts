import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import core from '../controllers/core.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await core.getTokenLiveStatus(request.body.token);
            return {
                live
            }
        }

    }

}