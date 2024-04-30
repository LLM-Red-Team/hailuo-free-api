import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "abab6-chat",
                        "object": "model",
                        "owned_by": "hailuo-free-api"
                    },
                    {
                        "id": "abab5.5s-chat",
                        "object": "model",
                        "owned_by": "hailuo-free-api"
                    },
                    {
                        "id": "abab5.5-chat",
                        "object": "model",
                        "owned_by": "hailuo-free-api"
                    }
                ]
            };
        }

    }
}