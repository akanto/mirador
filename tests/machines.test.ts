import { expect, test } from "bun:test";
import { joinCodeIn, machineAddress } from "../shared/machines.ts";

test("a machine is added by its name on the network, its address or an invite link from it", () => {
  expect(machineAddress("home-server.tailnet.ts.net")).toEqual({ origin: "https://home-server.tailnet.ts.net", joinCode: null });
  expect(machineAddress(" https://home-server.tailnet.ts.net/some/page ")).toEqual({ origin: "https://home-server.tailnet.ts.net", joinCode: null });
  expect(machineAddress("http://192.168.1.20:4600")).toEqual({ origin: "http://192.168.1.20:4600", joinCode: null });
  expect(machineAddress("https://home-server.tailnet.ts.net/#/join/ABCD-EFGH-JKLM")).toEqual({
    origin: "https://home-server.tailnet.ts.net",
    joinCode: "ABCD-EFGH-JKLM",
  });
});

test("what is not a web address is not a machine", () => {
  expect(machineAddress("")).toBeNull();
  expect(machineAddress("ftp://files.example")).toBeNull();
  expect(machineAddress("not a host name")).toBeNull();
});

test("only an invite link's #part carries a code", () => {
  expect(joinCodeIn("#/join/ABCD-EFGH-JKLM")).toBe("ABCD-EFGH-JKLM");
  expect(joinCodeIn("#/c/some-conversation")).toBeNull();
  expect(joinCodeIn("")).toBeNull();
});
