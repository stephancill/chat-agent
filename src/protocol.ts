// The subset of the Apron protocol (https://apron.chat/protocol) this bot uses.

export interface User {
  user_id: string;
  name?: string;
  roles?: string[];
}

export interface Body {
  text?: string;
  format?: "plain" | "markdown";
  mentions?: string[];
  embeds?: unknown[];
}

export interface Message {
  message_id?: string;
  log_id?: string;
  room_id?: string;
  from: User;
  body?: Body;
  reply_to?: { message_id: string; from?: User; body?: Body } | null;
  deleted?: boolean;
}

export interface Frame {
  id?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export const ERR = {
  denied: -32001,
  retryAfter: -32002,
  tooLarge: -32003,
  invalidParams: -32602,
} as const;

export class RequestError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: any,
  ) {
    super(message);
  }
}
