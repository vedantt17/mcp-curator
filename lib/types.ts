export type ToolMeta = {
  name: string;
  description: string;
  input_schema: any;
  composes: string[];
  examples?: { args: any; description: string }[];
};

export type NormalizedParam = {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema?: any;
  description?: string;
};

export type NormalizedOp = {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary?: string;
  description?: string;
  parameters?: NormalizedParam[];
  requestBody?: { required?: boolean; schema?: any };
};

export type NormalizedSpec = {
  name: string;
  baseUrl: string;
  authStyle: "bearer" | "apiKey-header";
  authParam?: string;
  ops: NormalizedOp[];
};
