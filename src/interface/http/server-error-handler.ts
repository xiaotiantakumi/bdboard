import type { ErrorHandler } from 'hono';

/** `app.onError` に付ける。stack・message は応答に入れない (console.error には出す)。HTTPException は Hono の既定と同じく、その応答をそのまま返す。 */
export const serverErrorHandler: ErrorHandler = (error, c) => {
  if ('getResponse' in error) {
    const res = error.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(error);
  return c.json({ error: 'internal error' }, 500);
};
