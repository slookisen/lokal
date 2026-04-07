#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "@modelcontextprotocol/sdk/node_modules/zod/lib/index.js";
const B = process.env.LOKAL_URL || "https://lokal.fly.dev";
const H = { Accept: "application/json", "User-Agent": "lokal-mcp/0.1.0" };
async function get(u){const r=await fetch(u,{headers:H});return r.json();}
async function post(u,b){const r=await fetch(u,{method:"POST",headers:{...H,"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();}
function fmt(a,i){const p=["**"+i+". "+a.name+"**"];if(a.description)p.push("  "+a.description);if(a.categories?.length)p.push("  Kategorier: "+a.categories.join(", "));if(a.location?.city)p.push("  By: "+a.location.city);if(a.url)p.push("  Web: "+a.url);return p.join("\n");}
const server = new McpServer({ name: "lokal", version: "0.1.0" });
server.tool("lokal_search","Search for local food in Norway. Examples: 'vegetables near Oslo', 'organic honey Bergen'.",{query:z.string(),limit:z.number().min(1).max(50).default(10)},async({query,limit})=>{const d=await get(B+"/api/marketplace/search?q="+encodeURIComponent(query)+"&limit="+(limit||10));if(!d.results?.length)return{content:[{type:"text",text:"Ingen resultater for: "+query}]};return{content:[{type:"text",text:"Lokal: "+d.count+" resultater for '"+query+"':\n\n"+d.results.map((r,i)=>fmt(r.agent,i+1)).join("\n\n")}]};});
server.tool("lokal_discover","Structured food search by categories, tags, location.",{categories:z.array(z.string()).optional(),tags:z.array(z.string()).optional(),lat:z.number().optional(),lng:z.number().optional(),maxDistanceKm:z.number().optional(),limit:z.number().default(10)},async(q)=>{const d=await post(B+"/api/marketplace/discover",{...q,role:"producer"});if(!d.results?.length)return{content:[{type:"text",text:"Ingen produsenter funnet."}]};return{content:[{type:"text",text:d.results.map((r,i)=>fmt(r.agent,i+1)).join("\n\n")}]};});
server.tool("lokal_info","Get producer details.",{agentId:z.string()},async({agentId})=>{const d=await get(B+"/api/marketplace/agents/"+agentId+"/info");return{content:[{type:"text",text:JSON.stringify(d,null,2)}]};});
server.tool("lokal_stats","Platform stats.",{},async()=>{const d=await get(B+"/api/stats");return{content:[{type:"text",text:JSON.stringify(d,null,2)}]};});
await server.connect(new StdioServerTransport());
