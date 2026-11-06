import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PluggyClient, PluggyError, decodeCredentials } from "./pluggy";

interface Env {}

type Creds = { clientId: string; clientSecret: string; itemId?: string };

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export class PluggyMcp extends McpAgent<Env, Record<string, never>, Creds> {
  server = new McpServer({ name: "pluggy", version: "0.1.0" });

  private client: PluggyClient | null = null;
  private credsKey = "";

  private getClient(): PluggyClient {
    const props = this.props;
    if (!props?.clientId || !props?.clientSecret) {
      throw new Error("Unauthorized: no Pluggy credentials on session");
    }
    const key = `${props.clientId}:${props.clientSecret}`;
    if (this.client && this.credsKey === key) return this.client;
    this.client = new PluggyClient(props.clientId, props.clientSecret);
    this.credsKey = key;
    return this.client;
  }

  private async run(fn: () => Promise<unknown>): Promise<ToolResult> {
    try {
      return ok(await fn());
    } catch (err) {
      if (err instanceof PluggyError) {
        return fail(`Pluggy API error ${err.status}: ${err.body || err.message}`);
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private resolveItemId(argItemId: string | undefined): string {
    const itemId = argItemId ?? this.props?.itemId;
    if (!itemId) {
      throw new Error("itemId is required: pass it as a tool arg or via the ?itemId= query param.");
    }
    return itemId;
  }

  async init() {
    const c = () => this.getClient();

    // ---- Items ----
    this.server.tool(
      "retrieve_item",
      "Retrieve a single Pluggy item by id, including status and execution info.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/items/${args.id}`)),
    );

    this.server.tool(
      "create_item",
      "Create an item and trigger a sync. Provide connectorId and parameters (credential key/values from GET /connectors).",
      {
        connectorId: z.number().int(),
        parameters: z
          .record(z.string(), z.string())
          .describe("Connector credentials as { name: value } pairs."),
        webhookUrl: z.string().url().optional(),
        clientUserId: z.string().optional(),
      },
      (args) => this.run(() => c().post("/items", args)),
    );

    this.server.tool(
      "update_item",
      "Trigger a new synchronization for an item, optionally updating stored credentials.",
      {
        id: z.string().uuid(),
        parameters: z
          .record(z.string(), z.string())
          .optional()
          .describe("New credentials { name: value }, or MFA value e.g. { token: '123456' }."),
        webhookUrl: z.string().url().optional(),
        clientUserId: z.string().optional(),
      },
      (args) => this.run(() => c().patch(`/items/${args.id}`, args)),
    );

    this.server.tool(
      "delete_item",
      "Delete an item by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().delete(`/items/${args.id}`)),
    );

    this.server.tool(
      "send_item_mfa",
      "Submit a multi-factor authentication value when an item is in WAITING_USER_INPUT.",
      {
        id: z.string().uuid(),
        parameterName: z
          .string()
          .describe("The MFA parameter 'name' from item.parameter.name (e.g. 'token')."),
        parameterValue: z.string().describe("The MFA value entered by the user."),
      },
      (args) =>
        this.run(() =>
          c().post(`/items/${args.id}/mfa`, { [args.parameterName]: args.parameterValue }),
        ),
    );

    // ---- Accounts ----
    this.server.tool(
      "list_accounts",
      "List accounts collected for an item. Filter by type BANK or CREDIT. itemId defaults to the session ?itemId= query param.",
      {
        itemId: z.string().uuid().optional(),
        type: z.enum(["BANK", "CREDIT"]).optional(),
      },
      (args) => this.run(() => c().get("/accounts", { ...args, itemId: this.resolveItemId(args.itemId) })),
    );

    this.server.tool(
      "retrieve_account",
      "Retrieve a single account by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/accounts/${args.id}`)),
    );

    this.server.tool(
      "get_real_time_balance",
      "Fetch the real-time balance for an account directly from the institution (no full sync).",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/accounts/${args.id}/balance`)),
    );

    // ---- Transactions ----
    this.server.tool(
      "list_transactions",
      "List transactions for an account (cursor-paginated, up to 12 months). Use 'after' from a previous response 'next'.",
      {
        accountId: z.string().uuid(),
        dateFrom: z.string().optional().describe("yyyy-mm-dd. Cannot combine with createdAtFrom."),
        dateTo: z.string().optional().describe("yyyy-mm-dd."),
        createdAtFrom: z
          .string()
          .optional()
          .describe("ISO datetime; transactions created at or after this date."),
        after: z.string().optional().describe("Cursor from a previous response 'next' value."),
      },
      (args) => this.run(() => c().get("/v2/transactions", args)),
    );

    this.server.tool(
      "retrieve_transaction",
      "Retrieve a single transaction by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/transactions/${args.id}`)),
    );

    this.server.tool(
      "update_transaction_category",
      "Override a transaction's category. Use a categoryId from list_categories.",
      {
        id: z.string().uuid(),
        categoryId: z.string(),
      },
      (args) =>
        this.run(() => c().patch(`/transactions/${args.id}`, { categoryId: args.categoryId })),
    );

    // ---- Investments ----
    this.server.tool(
      "list_investments",
      "List investments collected for an item. itemId defaults to the session ?itemId= query param.",
      {
        itemId: z.string().uuid().optional(),
        type: z
          .enum(["COE", "EQUITY", "ETF", "FIXED_INCOME", "MUTUAL_FUND", "SECURITY", "OTHER"])
          .optional(),
        page: z.number().int().optional(),
        pageSize: z.number().int().optional(),
      },
      (args) => this.run(() => c().get("/investments", { ...args, itemId: this.resolveItemId(args.itemId) })),
    );

    this.server.tool(
      "retrieve_investment",
      "Retrieve a single investment by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/investments/${args.id}`)),
    );

    this.server.tool(
      "list_investment_transactions",
      "List transactions for a specific investment.",
      {
        id: z.string().uuid(),
        page: z.number().int().optional(),
        pageSize: z.number().int().optional(),
      },
      (args) => this.run(() => c().get(`/investments/${args.id}/transactions`, args)),
    );

    // ---- Identities ----
    this.server.tool(
      "find_identity_by_item",
      "Retrieve the identity resource associated with an item, if available. itemId defaults to the session ?itemId= query param.",
      { itemId: z.string().uuid().optional() },
      (args) => this.run(() => c().get("/identity", { itemId: this.resolveItemId(args.itemId) })),
    );

    this.server.tool(
      "retrieve_identity",
      "Retrieve a single identity resource by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/identity/${args.id}`)),
    );

    // ---- Categories ----
    this.server.tool(
      "list_categories",
      "List active transaction categories, optionally filtered by parentId.",
      { parentId: z.string().optional() },
      (args) => this.run(() => c().get("/categories", args)),
    );

    this.server.tool(
      "retrieve_category",
      "Retrieve a single category by id.",
      { id: z.string() },
      (args) => this.run(() => c().get(`/categories/${args.id}`)),
    );

    // ---- Loans ----
    this.server.tool(
      "list_loans",
      "List loans collected for an item. itemId defaults to the session ?itemId= query param.",
      { itemId: z.string().uuid().optional() },
      (args) => this.run(() => c().get("/loans", { itemId: this.resolveItemId(args.itemId) })),
    );

    this.server.tool(
      "retrieve_loan",
      "Retrieve a single loan by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/loans/${args.id}`)),
    );

    // ---- Credit card bills ----
    this.server.tool(
      "list_bills",
      "List credit card bills collected for an account.",
      { accountId: z.string().uuid() },
      (args) => this.run(() => c().get("/bills", args)),
    );

    this.server.tool(
      "retrieve_bill",
      "Retrieve a single credit card bill by id.",
      { id: z.string().uuid() },
      (args) => this.run(() => c().get(`/bills/${args.id}`)),
    );

    // ---- Connectors ----
    this.server.tool(
      "list_connectors",
      "List available financial institution connectors with optional filters.",
      {
        countries: z.array(z.string()).optional(),
        types: z
          .array(
            z.enum([
              "PERSONAL_BANK",
              "BUSINESS_BANK",
              "INVESTMENT",
              "INVOICE",
              "TELECOMMUNICATION",
              "OTHER",
            ]),
          )
          .optional(),
        name: z.string().optional(),
        sandbox: z.boolean().optional(),
        healthDetails: z.boolean().optional(),
        isOpenFinance: z.boolean().optional(),
        supportsPaymentInitiation: z.boolean().optional(),
        supportsSmartTransfers: z.boolean().optional(),
        supportsAutomaticPix: z.boolean().optional(),
      },
      (args) => this.run(() => c().get("/connectors", args)),
    );

    this.server.tool(
      "retrieve_connector",
      "Retrieve a single connector by id, including its required credentials.",
      { id: z.number().int() },
      (args) => this.run(() => c().get(`/connectors/${args.id}`)),
    );
  }
}

const mcpHandler = PluggyMcp.serve("/mcp");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "OPTIONS") {
      const header =
        request.headers.get("Authorization") ?? request.headers.get("authorization");
      if (!header) return new Response("Missing Authorization header", { status: 401 });
      try {
        const props = decodeCredentials(header);
        const url = new URL(request.url);
        const itemId = url.searchParams.get("itemId");
        if (itemId) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
            return new Response("Invalid itemId: must be a UUID", { status: 400 });
          }
          props.itemId = itemId;
        }
        (ctx as ExecutionContext & { props?: Creds }).props = props;
      } catch (err) {
        return new Response(err instanceof Error ? err.message : "Invalid Authorization", {
          status: 401,
        });
      }
    }
    return mcpHandler.fetch(request, env, ctx);
  },
};
