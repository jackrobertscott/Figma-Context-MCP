import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService, type FigmaAuthOptions } from "./services/figma.js";
import type { SimplifiedDesign } from "./services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "./utils/logger.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
};

type CreateServerOptions = {
  isHTTP?: boolean;
  outputFormat?: "yaml" | "json";
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false, outputFormat = "yaml" }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  // const figmaService = new FigmaService(figmaApiKey);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, outputFormat);

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
): void {
  // Tool to get file information
  server.tool(
    "get_figma_data",
    "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
    {
      fileKey: z
        .string()
        .describe(
          "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
        ),
      nodeId: z
        .string()
        .optional()
        .describe(
          "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
        ),
      depth: z
        .number()
        .optional()
        .describe(
          "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree,",
        ),
    },
    async ({ fileKey, nodeId, depth }) => {
      try {
        Logger.log(
          `Fetching ${
            depth ? `${depth} layers deep` : "all layers"
          } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
        );

        let file: SimplifiedDesign;
        if (nodeId) {
          file = await figmaService.getNode(fileKey, nodeId, depth);
        } else {
          file = await figmaService.getFile(fileKey, depth);
        }

        Logger.log(`Successfully fetched file: ${file.name}`);
        const { nodes, globalVars, ...metadata } = file;

        const result = {
          metadata,
          nodes,
          globalVars,
        };

        Logger.log(`Generating ${outputFormat.toUpperCase()} result from file`);
        const formattedResult =
          outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

        Logger.log("Sending result to client");
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error fetching file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching file: ${message}` }],
        };
      }
    },
  );

  // TODO: Clean up all image download related code, particularly getImages in Figma service
  // Tool to download images
  server.tool(
    "download_figma_images",
    "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
    {
      fileKey: z.string().describe("The key of the Figma file containing the node"),
      nodes: z
        .object({
          nodeId: z
            .string()
            .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
          imageRef: z
            .string()
            .optional()
            .describe(
              "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
            ),
          fileName: z.string().describe("The local name for saving the fetched file"),
        })
        .array()
        .describe("The nodes to fetch as images"),
      pngScale: z
        .number()
        .positive()
        .optional()
        .default(2)
        .describe(
          "Export scale for PNG images. Optional, defaults to 2 if not specified. Affects PNG images only.",
        ),
      localPath: z
        .string()
        .describe(
          "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
        ),
      svgOptions: z
        .object({
          outlineText: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to outline text in SVG exports. Default is true."),
          includeId: z
            .boolean()
            .optional()
            .default(false)
            .describe("Whether to include IDs in SVG exports. Default is false."),
          simplifyStroke: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to simplify strokes in SVG exports. Default is true."),
        })
        .optional()
        .default({})
        .describe("Options for SVG export"),
    },
    async ({ fileKey, nodes, localPath, svgOptions, pngScale }) => {
      try {
        const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
          nodeId: string;
          imageRef: string;
          fileName: string;
        }[];
        const fillDownloads = figmaService.getImageFills(fileKey, imageFills, localPath);
        const renderRequests = nodes
          .filter(({ imageRef }) => !imageRef)
          .map(({ nodeId, fileName }) => ({
            nodeId,
            fileName,
            fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
          }));

        const renderDownloads = figmaService.getImages(
          fileKey,
          renderRequests,
          localPath,
          pngScale,
          svgOptions,
        );

        const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
          ...f,
          ...r,
        ]);

        // If any download fails, return false
        const saveSuccess = !downloads.find((success) => !success);
        return {
          content: [
            {
              type: "text",
              text: saveSuccess
                ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
                : "Failed",
            },
          ],
        };
      } catch (error) {
        Logger.error(`Error downloading images from file ${fileKey}:`, error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error downloading images: ${error}` }],
        };
      }
    },
  );

  // Tool to get local variables from a Figma file
  server.tool(
    "get_figma_local_variables",
    "Get all local variables and variable collections from a Figma file",
    {
      fileKey: z
        .string()
        .describe(
          "The key of the Figma file to fetch variables from, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
        ),
    },
    async ({ fileKey }) => {
      try {
        Logger.log(`Fetching local variables from file ${fileKey}`);
        const response = await figmaService.getLocalVariables(fileKey);
        
        const { variables, variableCollections } = response.meta;
        
        const result = {
          variables,
          variableCollections,
        };

        Logger.log(`Successfully fetched ${Object.keys(variables).length} variables and ${Object.keys(variableCollections).length} collections`);
        Logger.log(`Generating ${outputFormat.toUpperCase()} result from variables`);
        const formattedResult =
          outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

        Logger.log("Sending variables result to client");
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error fetching local variables from file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching local variables: ${message}` }],
        };
      }
    },
  );

  // Tool to get published variables from a Figma file
  server.tool(
    "get_figma_published_variables",
    "Get all published variables and variable collections from a Figma file",
    {
      fileKey: z
        .string()
        .describe(
          "The key of the Figma file to fetch published variables from, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
        ),
    },
    async ({ fileKey }) => {
      try {
        Logger.log(`Fetching published variables from file ${fileKey}`);
        const response = await figmaService.getPublishedVariables(fileKey);
        
        const { variables, variableCollections } = response.meta;
        
        const result = {
          variables,
          variableCollections,
        };

        Logger.log(`Successfully fetched ${Object.keys(variables).length} published variables and ${Object.keys(variableCollections).length} collections`);
        Logger.log(`Generating ${outputFormat.toUpperCase()} result from published variables`);
        const formattedResult =
          outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

        Logger.log("Sending published variables result to client");
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error fetching published variables from file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching published variables: ${message}` }],
        };
      }
    },
  );

  // Tool to update variables in a Figma file
  server.tool(
    "update_figma_variables",
    "Create, update, or delete variables, variable collections, modes, and mode values in a Figma file",
    {
      fileKey: z
        .string()
        .describe(
          "The key of the Figma file to update variables in, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
        ),
      changes: z
        .object({
          variableCollections: z
            .array(
              z.discriminatedUnion("action", [
                z.object({
                  action: z.literal("CREATE"),
                  id: z.string().optional().describe("Optional temporary ID for this collection"),
                  name: z.string().describe("Collection name (required for CREATE)"),
                  description: z.string().optional().describe("Collection description"),
                  modes: z
                    .array(
                      z.object({
                        name: z.string().describe("Mode name"),
                        modeId: z.string().optional().describe("Mode ID for existing modes"),
                      })
                    )
                    .optional()
                    .describe("Initial modes for the collection"),
                }),
                z.object({
                  action: z.literal("UPDATE"),
                  id: z.string().describe("ID of the collection to update"),
                  name: z.string().optional().describe("New collection name"),
                  description: z.string().optional().describe("New collection description"),
                }),
                z.object({
                  action: z.literal("DELETE"),
                  id: z.string().describe("ID of the collection to delete"),
                }),
              ])
            )
            .optional()
            .describe("Variable collection changes"),
          variableModes: z
            .array(
              z.discriminatedUnion("action", [
                z.object({
                  action: z.literal("CREATE"),
                  id: z.string().optional().describe("Optional temporary ID for this mode"),
                  variableCollectionId: z.string().describe("ID of the variable collection this mode belongs to"),
                  name: z.string().describe("Mode name (required for CREATE)"),
                }),
                z.object({
                  action: z.literal("UPDATE"),
                  id: z.string().describe("ID of the mode to update"),
                  variableCollectionId: z.string().describe("ID of the variable collection this mode belongs to"),
                  name: z.string().optional().describe("New mode name"),
                }),
                z.object({
                  action: z.literal("DELETE"),
                  id: z.string().describe("ID of the mode to delete"),
                }),
              ])
            )
            .optional()
            .describe("Variable mode changes"),
          variables: z
            .array(
              z.discriminatedUnion("action", [
                z.object({
                  action: z.literal("CREATE"),
                  id: z.string().optional().describe("Optional temporary ID for this variable"),
                  name: z.string().describe("Variable name (required for CREATE)"),
                  description: z.string().optional().describe("Variable description"),
                  variableCollectionId: z.string().describe("ID of the variable collection (required for CREATE)"),
                  resolvedType: z
                    .enum(["BOOLEAN", "COLOR", "FLOAT", "STRING"])
                    .describe("Variable type (required for CREATE)"),
                  remote: z.boolean().optional().describe("Whether variable is remote/published"),
                  scopes: z
                    .array(z.enum([
                      "ALL_SCOPES",
                      "TEXT_CONTENT", 
                      "CORNER_RADIUS",
                      "WIDTH_HEIGHT",
                      "GAP",
                      "ALL_FILLS",
                      "FRAME_FILL",
                      "SHAPE_FILL", 
                      "TEXT_FILL",
                      "STROKE_COLOR",
                      "EFFECT_COLOR"
                    ]))
                    .optional()
                    .describe("Scopes where this variable can be applied"),
                }),
                z.object({
                  action: z.literal("UPDATE"),
                  id: z.string().describe("ID of the variable to update"),
                  name: z.string().optional().describe("New variable name"),
                  description: z.string().optional().describe("New variable description"),
                  remote: z.boolean().optional().describe("Whether variable is remote/published"),
                  scopes: z
                    .array(z.enum([
                      "ALL_SCOPES",
                      "TEXT_CONTENT", 
                      "CORNER_RADIUS",
                      "WIDTH_HEIGHT",
                      "GAP",
                      "ALL_FILLS",
                      "FRAME_FILL",
                      "SHAPE_FILL", 
                      "TEXT_FILL",
                      "STROKE_COLOR",
                      "EFFECT_COLOR"
                    ]))
                    .optional()
                    .describe("Scopes where this variable can be applied"),
                }),
                z.object({
                  action: z.literal("DELETE"),
                  id: z.string().describe("ID of the variable to delete"),
                }),
              ])
            )
            .optional()
            .describe("Variable changes"),
          variableModeValues: z
            .array(
              z.object({
                variableId: z.string().describe("Variable ID (can use temp ID)"),
                modeId: z.string().describe("Mode ID within the variable collection"),
                value: z
                  .union([
                    z.boolean(),
                    z.number(),
                    z.string(),
                    z.object({
                      r: z.number().min(0).max(1),
                      g: z.number().min(0).max(1),
                      b: z.number().min(0).max(1),
                      a: z.number().min(0).max(1).optional(),
                    }),
                    z.object({
                      type: z.literal("VARIABLE_ALIAS"),
                      id: z.string(),
                    }),
                  ])
                  .describe("The value for this variable in this mode (boolean, number, string, color object, or variable alias)"),
              })
            )
            .optional()
            .describe("Variable mode values to set"),
        })
        .describe("The changes to make to variables, collections, modes, and values"),
    },
    async ({ fileKey, changes }) => {
      try {
        Logger.log(`Updating variables in file ${fileKey}`);
        Logger.log("Processing changes:", JSON.stringify(changes, null, 2));
        
        const response = await figmaService.updateVariables(fileKey, changes);
        
        const result = {
          status: response.status,
          error: response.error,
          meta: response.meta || {},
        };

        Logger.log("Variables updated successfully");
        Logger.log(`Generating ${outputFormat.toUpperCase()} result from update response`);
        const formattedResult =
          outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

        Logger.log("Sending update result to client");
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error updating variables in file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating variables: ${message}` }],
        };
      }
    },
  );
}

export { createServer };
