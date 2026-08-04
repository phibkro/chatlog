import { WorkbenchData } from "../src/workbench/data";
import {
  workbenchHandler as productionWorkbenchHandler,
  type WorkbenchHandlerOptions,
} from "../src/workbench/server";
import { ContextManagement } from "../src/workbench/context-management";
import { MemoryLab } from "../src/workbench/memory-lab";

const TEST_ORIGIN = "http://localhost";
const TEST_CREDENTIAL = "chatlog-workbench-test-credential";

export function workbenchHandler(
  data: WorkbenchData,
  publicRoot?: string,
  memoryLab: MemoryLab | null = null,
  memoryLabWrites = false,
  contextManagement?: ContextManagement | null,
  contextWrites = false,
  options: WorkbenchHandlerOptions = {},
) {
  const handler = productionWorkbenchHandler(
    data,
    publicRoot,
    memoryLab,
    memoryLabWrites,
    contextManagement,
    contextWrites,
    {
      ...options,
      auth: {
        credential: TEST_CREDENTIAL,
        operatorId: "test-workbench-operator",
        origin: TEST_ORIGIN,
        ...options.auth,
      },
    },
  );
  return (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set("Host", "localhost");
    headers.set("Origin", TEST_ORIGIN);
    headers.set("Authorization", `Bearer ${TEST_CREDENTIAL}`);
    return handler(new Request(request, { headers }));
  };
}
