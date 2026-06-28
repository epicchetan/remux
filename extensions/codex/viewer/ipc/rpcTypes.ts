export type JsonRpcId = number | string;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    data?: unknown;
    message: string;
  };
};
