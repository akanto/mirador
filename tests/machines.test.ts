import { expect, test } from "bun:test";
import { authorityFingerprintIn, inviteIn, inviteLink, joinCodeIn, machineAddress } from "../shared/machines.ts";

test("a machine is added by its name on the network, its address or an invite link from it", () => {
  expect(machineAddress("home-server.tailnet.ts.net")).toEqual({ origin: "https://home-server.tailnet.ts.net", joinCode: null, authorityFingerprint: null });
  expect(machineAddress(" https://home-server.tailnet.ts.net/some/page ")).toMatchObject({ origin: "https://home-server.tailnet.ts.net", joinCode: null });
  expect(machineAddress("http://192.168.1.20:4600")).toMatchObject({ origin: "http://192.168.1.20:4600", joinCode: null });
  expect(machineAddress("https://home-server.tailnet.ts.net/#/join/ABCD-EFGH-JKLM")).toEqual({
    origin: "https://home-server.tailnet.ts.net",
    joinCode: "ABCD-EFGH-JKLM",
    authorityFingerprint: null,
  });
});

const fingerprint = "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x_-";

test("an invite link from a machine with its own certificate authority carries the authority's fingerprint after the code", () => {
  const link = inviteLink("https://box.local:4602", "ABCD-EFGH-JKLM", fingerprint);
  expect(link).toBe(`https://box.local:4602/#/join/ABCD-EFGH-JKLM/${fingerprint}`);
  expect(machineAddress(link)).toEqual({ origin: "https://box.local:4602", joinCode: "ABCD-EFGH-JKLM", authorityFingerprint: fingerprint });
  expect(joinCodeIn(`#/join/ABCD-EFGH-JKLM/${fingerprint}`)).toBe("ABCD-EFGH-JKLM");
  expect(authorityFingerprintIn(`#/join/ABCD-EFGH-JKLM/${fingerprint}`)).toBe(fingerprint);
  expect(inviteLink("https://box.example.ts.net", "ABCD-EFGH-JKLM")).toBe("https://box.example.ts.net/#/join/ABCD-EFGH-JKLM");
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

test("takes the invite code and certificate authority's fingerprint out of a pasted invite link, or the code as typed", () => {
  expect(inviteIn("https://home-server.example.ts.net/#/join/ABCD-EFGH-JKLM")).toEqual({ code: "ABCD-EFGH-JKLM", authorityFingerprint: null });
  expect(inviteIn(`https://home-server.local:4602/#/join/ABCD-EFGH-JKLM/${fingerprint}`)).toEqual({ code: "ABCD-EFGH-JKLM", authorityFingerprint: fingerprint });
  expect(inviteIn("  ABCD-EFGH-JKLM \n")).toEqual({ code: "ABCD-EFGH-JKLM", authorityFingerprint: null });
});
