// @ts-check
const { randomUUID } = require('crypto');
const { serialize } = require('./serialize-to-js-master/src');

const db = require('../../models');
const JWTService = require('../../services/JwtService');
const ValidationService = require('../../services/ValidationService');
const UploadService = require('../../services/UploadService');
const { errorCodes } = require('../../core/strings');
const RedisService = require('../../services/RedisService');
const EncryptionService = require('../../services/EncryptionService');

const encryptionService = new EncryptionService();

const redis = new RedisService();

const project = process.env.COMPANY;

const MESSAGE_TYPE_MAPPING = {
  TEXT: 1,
  IMAGE: 2,
  TEXT_AND_IMAGE: 3,
};

const TIMEOUT = 60 * 1000;

function deserialize(serializedJavascript) {
  return eval('(' + serializedJavascript + ')');
}

const AuthService = {
  verify: async (req, res, next) => {
    const token = req.headers.authorization;
    const cleanToken = token?.replace?.('Bearer ', '');

    if (cleanToken) {
      const verify = JWTService.verifyAccessToken(cleanToken);

      if (verify == null || verify?.user_id == null || !(verify?.role_id == 2) || verify?.wallet == null) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token',
          code: 'UNAUTHENTICATED',
        });
      }
      const user = await db.user.getByFields(
        {
          status: 1,
          id: verify?.user_id,
        },
        {
          attributes: ['id', 'status'],
          include: [
            {
              model: db.credential,
              as: 'credential',
              attributes: ['id', 'account_status', 'status'],
              where: {
                status: 1,
                account_status: 1,
              },
            },
          ],
        },
      );

      req.authentication = { ...verify, user };
      return next();
    }
    return res.status(401).json({
      success: false,
      message: 'Access denied.',
      code: 'UNAUTHENTICATED',
    });
  },
};

const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === 'function') {
      return value.toString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    return value;
  };
};

async function publishMessage(message, rawMessage) {
  try {
    const senderIdFromPublish = rawMessage?.sender_id;
    const receiverIdFromPublish = rawMessage?.receiver_id;

    const key = encryptionService.base64Encrypt(`${project}#${senderIdFromPublish}|${receiverIdFromPublish}`);

    console.log('---TO BE PUBLISHED---', senderIdFromPublish, receiverIdFromPublish, `${project}#${senderIdFromPublish}|${receiverIdFromPublish}`, key);

    const subscribers = await redis.client.sendCommand(['ZRANGE', key, `${+new Date() - TIMEOUT}`, `${+new Date()}`, 'BYSCORE']);

    if (subscribers?.length > 0) {
      subscribers.forEach((payload) => {
        const { req, res } = deserialize(payload);
        const { userId } = req.query;

        const receiverId = req?.authentication?.user_id;
        const senderId = userId;

        console.log('----CONDITION---', senderId, receiverId, senderIdFromPublish, receiverIdFromPublish);

        const canPublish = senderId == senderIdFromPublish && receiverId == receiverIdFromPublish;

        console.log(canPublish, typeof res.json);

        canPublish && res.json({ success: true, data: { message } });
      });
    }

    // const publishedConnections = [];
    // connections.forEach(({ req, res }) => {
    //   const uuid = req.uuid;
    //   const { userId } = req.query;

    //   // These are swapped
    //   const receiverId = req?.authentication?.user_id;
    //   const senderId = userId;

    //   const senderIdFromPublish = +rawMessage?.sender_id;
    //   const receiverIdFromPublish = +rawMessage?.receiver_id;

    //   const canPublish = senderId == senderIdFromPublish && receiverId == receiverIdFromPublish;

    //   canPublish && publishedConnections.push(uuid);

    //   canPublish && res.json({ success: true, data: { message } });
    // });
    // const filteredPublishedConnections = connections?.filter((connection) => {
    //   const uuid = connection?.req?.uuid;
    //   return !publishedConnections.includes(uuid);
    // });
    // connections = filteredPublishedConnections;
  } catch (_) {
    console.log('---', _);
    if (process.env.DEBUG === 'true') {
      console.warn('Failed to publish message', _);
    }
  }
}

module.exports = {
  initializeApi: function (app) {
    app.get(
      '/member/api/chat/poll',
      AuthService.verify,
      ValidationService.validateInput(
        {
          userId: 'required|integer',
        },
        {
          'userId.required': 'Receiver user Id is required.',
          'userId.integer': 'Receiver user Id should be an integer.',
        },
        'query',
      ),
      ValidationService.handleValidationErrorForAPI,
      async (req, res) => {
        req.uuid = randomUUID();
        const { uptime } = req.query;
        try {
          const receiverId = req.query?.userId;
          const senderId = req?.authentication?.user_id;

          const key = encryptionService.base64Encrypt(`${project}#${receiverId}|${senderId}`);

          console.log('----SUBSCRIBER----', senderId, receiverId, uptime, key, `${project}#${receiverId}|${senderId}`);

          await redis.client.sendCommand(['ZREMRANGEBYSCORE', key, '-inf', `${+new Date() - TIMEOUT}`]);

          if (+uptime === 0) {
            return res.status(200).json({
              success: true,
              message: 'CONNECTED',
            });
          } else {
            await redis.client.sendCommand([
              'ZADD',
              key,
              `${+new Date()}`,
              serialize({
                req: {
                  query: req.query,
                  authentication: req.authentication,
                },
                res,
              }),
            ]);
          }
        } catch (_) {
          console.log('----ERROR', _);
          return res.status(500).json({
            success: false,
            message: 'Something went wrong.',
          });
        }
      },
    );

    app.post(
      '/member/api/chat/send-message',
      AuthService.verify,
      ValidationService.validateInput(
        {
          toUserId: 'required|integer',
          messageType: 'required|in:TEXT,IMAGE,TEXT_AND_IMAGE',
          text: 'requiredIf:messageType,TEXT,TEXT_AND_IMAGE',
          image: 'requiredIf:messageType,IMAGE,TEXT_AND_IMAGE',
        },
        {
          'toUserId.required': 'Receiver Id is required.',
          'toUserId.integer': 'Receiver Id should be an integer.',
          'messageType.required': 'Message Type is required.',
          'messageType.in': 'Message Type should be within TEXT, TEXT_AND_IMAGE, IMAGE',
          'text.requiredIf': 'Text field is required if messageType = TEXT,TEXT_AND_IMAGE',
          'image.requiredIf': 'Image field is required if messageType = IMAGE,TEXT_AND_IMAGE',
        },
      ),
      async (req, res) => {
        const { toUserId, text, messageType = MESSAGE_TYPE_MAPPING.TEXT, image } = req.body;

        const { user_id: fromUserId } = req?.authentication;

        const _newMessage = {
          id: null,
        };

        try {
          const isMyself = toUserId == fromUserId;
          if (isMyself) {
            return {
              success: false,
              message: 'Cannot send message to yourself.',
              code: errorCodes.chat.CANNOT_SEND_MESSAGE_TO_YOURSELF,
            };
          }
          const isBlocked = await db.blocked_user.getByFields(
            {
              user_id: toUserId,
              blocked_user_id: fromUserId,
              status: 1,
            },
            {
              attributes: ['id'],
            },
          );

          if (isBlocked) {
            return {
              success: false,
              message: 'Permission denied.',
              code: errorCodes.extra.PERMISSION_DENIED,
            };
          }
          const receiverUser = await db.user.getByFields(
            {
              status: 1,
              id: toUserId,
            },
            {
              attributes: ['id', 'username', 'image', 'image_type'],
              include: [
                {
                  model: db.credential,
                  as: 'credential',
                  attributes: ['id', 'account_status', 'status'],
                  where: {
                    status: 1,
                    account_status: 1,
                  },
                },
              ],
            },
          );

          if (!receiverUser) {
            return res.status(404).json({
              success: false,
              message: 'Receiver user does not exist.',
              code: errorCodes.account.ACCOUNT_DOES_NOT_EXISTS,
            });
          }

          const actualMessageType = MESSAGE_TYPE_MAPPING[messageType];
          const newMessage = await db.chat_message.insert(
            {
              status: 1,
              message_type: actualMessageType,
              text: actualMessageType == 1 || actualMessageType == 3 ? text : null,
              ...(actualMessageType == 2 || actualMessageType == 3
                ? {
                    image,
                    image_type: UploadService.getImageType(),
                  }
                : {}),
              sender_id: fromUserId,
              receiver_id: toUserId,
            },
            {
              returnAllFields: true,
            },
          );
          _newMessage.id = newMessage?.id;

          const newMessagePayload = {
            id: newMessage?.id,
            text: !(actualMessageType == 2) ? newMessage?.text : null,
            messageType,
            imageUrl: [2, 3].includes(actualMessageType) ? UploadService.constructImageUrlMatchingMapping(newMessage?.image, newMessage?.image_type) : null,
            createdAt: newMessage?.createdAt || newMessage?.created_at,
            toUser: { ...receiverUser?.dataValues, image: receiverUser?.image },
          };

          await publishMessage(newMessagePayload, newMessage);

          return res.status(200).json({
            success: true,
            message: 'Message sent.',
            data: newMessagePayload,
          });
        } catch (error) {
          return res.status(500).json({
            success: false,
            message: 'Something went wrong.',
          });
        }
      },
    );

    return app;
  },
};
