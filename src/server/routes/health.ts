import { redis } from "../../lib/redis";
export async function health(app:any) {
   app.get('/health', async (req:any, reply:any) => {
  try {
    await redis.ping();
    
    const tokenCount = await redis.zcard('index:volume');

    reply.code(200).send({
      status: 'ok',
      uptime: process.uptime(),
      token_count: tokenCount
    });
  } catch (err) {
    reply.code(503).send({
      status: 'redis_down'
    });
  }
});
 
}