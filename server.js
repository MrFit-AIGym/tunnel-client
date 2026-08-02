import "dotenv/config";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import {
  expandedUtcRange,
  memberEmailHashes,
  rankAttendances,
  safeAttendanceDetail,
  safeMembership,
  sortEntriesChronologically,
  uniqueAttendances,
  validateDateRange,
} from "./lib.js";
import {
  calculateDailyCoachAttendance,
  loadOperationalData,
} from "./coach-ranking.js";
import {
  branchIdFromName,
  branchName,
} from "./coach-config.js";

const BASE_URL = "https://evo-integracao-api.w12app.com.br";
const PORT = Number(process.env.PORT || 8787);
const TIME_ZONE = process.env.EVO_TIME_ZONE || "America/Mexico_City";
const MAX_PAGES = Math.max(1, Math.min(Number(process.env.EVO_MAX_PAGES || 25), 50));
const MAX_RANKING_DAYS = Math.max(1, Math.min(Number(process.env.EVO_MAX_RANKING_DAYS || 93), 366));
const MEMBER_HASH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const memberHashCache = new Map();

function requireCredentials() {
  const dns = process.env.EVO_DNS?.trim();
  const token = process.env.EVO_TOKEN?.trim();
  if (!dns || !token) {
    throw new Error("Faltan las credenciales de EVO. Ejecute: bash configurar.sh");
  }
  return { dns, token };
}

function authorizationHeader() {
  const { dns, token } = requireCredentials();
  return `Basic ${Buffer.from(`${dns}:${token}`, "utf8").toString("base64")}`;
}

function rowsFromResponse(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["data", "items", "results", "value"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data && typeof data === "object" && data.idMember != null) return [data];
  return [];
}

async function evoGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authorizationHeader(),
      Accept: "application/json",
      "User-Agent": "evo-chatgpt-readonly/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const safeMessage = response.status === 401
      ? "EVO rechazó las credenciales (401). Revise DNS, token y vigencia."
      : response.status === 403
        ? "El token de EVO no tiene permiso para esta consulta (403)."
        : response.status === 429
          ? "EVO alcanzó el límite de solicitudes (429). Espere a que se restablezca."
          : `EVO respondió con error HTTP ${response.status}.`;
    const error = new Error(safeMessage);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function evoGetAll(path, params, take) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = rowsFromResponse(await evoGet(path, {
      ...params,
      take,
      skip: page * take,
    }));
    rows.push(...batch);
    if (batch.length < take) return { rows, truncated: false, requests: page + 1 };
  }
  return { rows, truncated: true, requests: MAX_PAGES };
}

async function evoMemberEmailHashes(memberIds) {
  const uniqueIds = [...new Set(
    memberIds
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )];
  const hashes = new Map();
  let requests = 0;

  const pendingIds = [];
  for (const idMember of uniqueIds) {
    const cached = memberHashCache.get(idMember);
    if (cached && Date.now() - cached.savedAt < MEMBER_HASH_CACHE_TTL_MS) {
      hashes.set(idMember, cached.hashes);
    } else {
      pendingIds.push(idMember);
    }
  }

  // El endpoint basico devuelve un solo socio y requiere filtrar por ID.
  // Hacemos grupos pequenos en paralelo y descartamos cualquier dato crudo
  // en cuanto se genera el hash irreversible.
  for (let index = 0; index < pendingIds.length; index += 4) {
    const chunk = pendingIds.slice(index, index + 4);
    const results = await Promise.all(chunk.map(async (idMember) => {
      try {
        const data = await evoGet("/api/v1/members/basic", {
          idMember,
          take: 1,
          skip: 0,
        });
        return { idMember, member: rowsFromResponse(data)[0] ?? null, requests: 1 };
      } catch (error) {
        if (![403, 404].includes(error?.status)) throw error;
      }

      // Compatibilidad para cuentas que solo habilitan el perfil v2.
      try {
        const data = await evoGet(`/api/v2/members/${idMember}`);
        return { idMember, member: rowsFromResponse(data)[0] ?? null, requests: 2 };
      } catch (error) {
        if (![403, 404].includes(error?.status)) throw error;
        return { idMember, member: null, requests: 2 };
      }
    }));

    for (const result of results) {
      requests += result.requests;
      const memberHashes = memberEmailHashes(result.member);
      hashes.set(result.idMember, memberHashes);
      memberHashCache.set(result.idMember, {
        hashes: memberHashes,
        savedAt: Date.now(),
      });
    }
  }

  return { hashes, requests };
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : "Error inesperado.";
  console.error(`[${new Date().toISOString()}] ${message}`);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function createEvoServer() {
  const server = new McpServer(
    { name: "abc-evo-lectura", version: "1.0.0" },
    {
      instructions:
        "Servidor interno de ABC EVO, exclusivamente de lectura. Nunca solicites ni muestres DNS, token, documentos, datos de pago o información financiera. Para asistencias, cuenta como máximo una asistencia por cliente, fecha y sede, y excluye accesos bloqueados o intentos fallidos.",
    },
  );

  server.registerTool(
    "consultar_plan_cliente",
    {
      title: "Consultar ID y plan de un cliente",
      description:
        "Busca en ABC EVO el ID, sede, plan y vigencia de un cliente por nombre o ID. Solo devuelve campos operativos seguros; nunca devuelve documentos, cobros, ventas ni datos de pago.",
      inputSchema: {
        nombre: z.string().trim().min(2).max(120).optional().describe("Nombre o parte del nombre del cliente"),
        idCliente: z.number().int().positive().optional().describe("ID exacto del cliente en EVO"),
        incluirCancelados: z.boolean().default(false).describe("Incluir también planes cancelados"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ nombre, idCliente, incluirCancelados }) => {
      try {
        if (!nombre && !idCliente) throw new Error("Indique el nombre o el ID del cliente.");
        const { rows, truncated, requests } = await evoGetAll(
          "/api/v3/membermembership",
          {
            memberName: nombre,
            idMember: idCliente,
            statusMemberMembership: incluirCancelados ? undefined : 1,
            showTransfers: false,
            showAggregators: false,
            showVips: false,
          },
          25,
        );
        const matches = rows.map(safeMembership);
        return textResult({ matches, count: matches.length, truncated, evoRequests: requests });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "asistencias_cliente",
    {
      title: "Consultar asistencias de un cliente",
      description:
        "Cuenta asistencias de un cliente en un periodo. Deduplica cada cliente por fecha y sede: varias entradas el mismo día en la misma sede cuentan como una. Excluye bloqueos e intentos fallidos.",
      inputSchema: {
        idCliente: z.number().int().positive().describe("ID del cliente en EVO"),
        fechaInicio: z.string().describe("Fecha inicial en formato AAAA-MM-DD"),
        fechaFin: z.string().describe("Fecha final en formato AAAA-MM-DD"),
        idSede: z.number().int().positive().optional().describe("ID de sede; si se omite incluye las sedes accesibles por el token"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ idCliente, fechaInicio, fechaFin, idSede }) => {
      try {
        validateDateRange(fechaInicio, fechaFin, 366);
        const { rows, truncated, requests } = await evoGetAll(
          "/api/v1/entries",
          { ...expandedUtcRange(fechaInicio, fechaFin), idMember: idCliente },
          1000,
        );
        const filtered = uniqueAttendances(sortEntriesChronologically(rows), {
          timeZone: TIME_ZONE,
          startDate: fechaInicio,
          endDate: fechaFin,
          idBranch: idSede,
        });
        return textResult({
          idClient: idCliente,
          startDate: fechaInicio,
          endDate: fechaFin,
          idBranch: idSede ?? null,
          attendanceCount: filtered.attendances.length,
          attendances: filtered.attendances,
          ignoredBlockedOrUnsuccessful: filtered.blockedOrUnsuccessful,
          truncated,
          evoRequests: requests,
          countingRule: "Máximo una asistencia por cliente, fecha y sede.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "resumen_asistencias",
    {
      title: "Resumen y ranking de asistencias",
      description:
        "Obtiene totales diarios y ranking de clientes por asistencias en un periodo. Una asistencia es única por cliente, fecha y sede. Excluye bloqueos e intentos fallidos.",
      inputSchema: {
        fechaInicio: z.string().describe("Fecha inicial en formato AAAA-MM-DD"),
        fechaFin: z.string().describe("Fecha final en formato AAAA-MM-DD"),
        idSede: z.number().int().positive().optional().describe("ID de sede; si se omite incluye las sedes accesibles por el token"),
        cantidadRanking: z.number().int().min(1).max(50).default(10).describe("Número de clientes en el ranking"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fechaInicio, fechaFin, idSede, cantidadRanking }) => {
      try {
        validateDateRange(fechaInicio, fechaFin, MAX_RANKING_DAYS);
        const { rows, truncated, requests } = await evoGetAll(
          "/api/v1/entries",
          expandedUtcRange(fechaInicio, fechaFin),
          1000,
        );
        const filtered = uniqueAttendances(sortEntriesChronologically(rows), {
          timeZone: TIME_ZONE,
          startDate: fechaInicio,
          endDate: fechaFin,
          idBranch: idSede,
        });
        const summary = rankAttendances(filtered.attendances, cantidadRanking);
        return textResult({
          startDate: fechaInicio,
          endDate: fechaFin,
          idBranch: idSede ?? null,
          totalAttendances: filtered.attendances.length,
          ...summary,
          ignoredBlockedOrUnsuccessful: filtered.blockedOrUnsuccessful,
          truncated,
          evoRequests: requests,
          countingRule: "Máximo una asistencia por cliente, fecha y sede.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "detalle_asistencias_diarias",
    {
      title: "Detalle seguro de asistencias diarias",
      description:
        "Obtiene una lista paginada de clientes con su sede, primera entrada válida del día y hashes SHA-256 irreversibles de todos sus correos válidos para cruces privados. Nunca devuelve correos originales, documentos, cobros, ventas, membresías ni datos de pago.",
      inputSchema: {
        fecha: z
          .string()
          .describe("Fecha de consulta en formato AAAA-MM-DD"),
        sucursal: z
          .string()
          .min(2)
          .max(40)
          .describe(
            "Nombre de la sucursal: Zinacantepec, López Mateos, Cosmovitral o Metepec",
          ),
        pagina: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Página solicitada"),
        cantidad: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(200)
          .describe("Registros por página; máximo 200"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fecha, sucursal, pagina, cantidad }) => {
      try {
        validateDateRange(fecha, fecha, 1);

        const branchId = branchIdFromName(sucursal);
        const nombreSucursal = branchName(branchId);

        const { rows, truncated, requests } = await evoGetAll(
          "/api/v1/entries",
          expandedUtcRange(fecha, fecha),
          1000,
        );

        const filtered = uniqueAttendances(
          sortEntriesChronologically(rows),
          {
            timeZone: TIME_ZONE,
            startDate: fecha,
            endDate: fecha,
            idBranch: branchId,
          },
        );

        const totalClientes = filtered.attendances.length;
        const totalPaginas = Math.max(
          1,
          Math.ceil(totalClientes / cantidad),
        );
        const start = (pagina - 1) * cantidad;
        const attendancesPage = filtered.attendances
          .slice(start, start + cantidad);
        const emailHashes = await evoMemberEmailHashes(
          attendancesPage.map((attendance) => attendance.idMember),
        );
        const clientes = attendancesPage
          .map((attendance) =>
            safeAttendanceDetail(
              attendance,
              TIME_ZONE,
              emailHashes.hashes.get(Number(attendance.idMember)),
            ),
          );

        return textResult({
          fecha,
          sucursal: nombreSucursal,
          idSede: branchId,
          pagina,
          cantidad,
          totalPaginas,
          totalClientes,
          clientes,
          registrosBloqueadosOInvalidos:
            filtered.blockedOrUnsuccessful,
          consultaCompleta: !truncated,
          solicitudesEVO: requests + emailHashes.requests,
          clientesConHash: clientes.filter((client) => client.emailHashes.length > 0).length,
          reglaConteo:
            "Cada cliente aparece máximo una vez por día y sucursal, usando su primera entrada válida.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );


  server.registerTool(
    "asistencias_entrenadores",
    {
      title: "Asistencias diarias por entrenador",
      description:
        "Calcula las asistencias únicas correspondientes a cada entrenador según la sucursal, fecha, horario base, rol de fin de semana y excepciones. Cada cliente se asigna usando su primera entrada válida del día. En el caso de Max, durante su clase se sustituyen las entradas generales por los asistentes registrados manualmente.",
      inputSchema: {
        fecha: z
          .string()
          .describe("Fecha del cálculo en formato AAAA-MM-DD"),
        sucursal: z
          .string()
          .min(2)
          .max(40)
          .describe(
            "Nombre de la sucursal: Zinacantepec, López Mateos, Cosmovitral o Metepec",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fecha, sucursal }) => {
      try {
        validateDateRange(fecha, fecha, 1);

        const branchId = branchIdFromName(sucursal);
        const nombreSucursal = branchName(branchId);

        const { rows, truncated, requests } = await evoGetAll(
          "/api/v1/entries",
          expandedUtcRange(fecha, fecha),
          1000,
        );

        const filtered = uniqueAttendances(sortEntriesChronologically(rows), {
          timeZone: TIME_ZONE,
          startDate: fecha,
          endDate: fecha,
          idBranch: branchId,
        });

        const operationalData = loadOperationalData();

        const result = calculateDailyCoachAttendance(
          filtered.attendances,
          {
            date: fecha,
            branchId,
            timeZone: TIME_ZONE,
            ...operationalData,
          },
        );

        const entrenadores = result.coaches.map(
          ({ branchId: hiddenBranchId, branchName: hiddenBranchName, ...coach }) => ({
            entrenador: coach.coach,
            horarioInicio: coach.start,
            horarioFin: coach.end,
            clientesEVO: coach.gymEntryCount,
            asistentesClase: coach.manualClassCount,
            duplicadosEliminados: coach.overlapRemoved,
            totalClientes: coach.attendanceCount,
            reglaClase: coach.classRule,
            origenHorario: coach.scheduleSource,
          }),
        );

        return textResult({
          fecha,
          sucursal: nombreSucursal,
          clientesUnicosDelDia: result.uniqueVisitors,
          entrenadores,
          clientesSinTurnoAsignado: result.unassignedVisitors,
          registrosBloqueadosOInvalidos:
            filtered.blockedOrUnsuccessful,
          consultaCompleta: !truncated,
          solicitudesEVO: requests,
          reglaConteo:
            "Cada cliente cuenta máximo una vez por día y sucursal, usando su primera entrada válida.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (
    req.method === "GET" &&
    [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ].includes(url.pathname)
  ) {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ resource: `http://127.0.0.1:${PORT}/mcp` }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ service: "ABC EVO lectura", status: "ok", mcp: "/mcp" }));
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === "/mcp") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createEvoServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error procesando MCP:", error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor ABC EVO (solo lectura) disponible en http://0.0.0.0:${PORT}/mcp`);
  console.log("Mantenga esta ventana abierta mientras use la integración.");
});
