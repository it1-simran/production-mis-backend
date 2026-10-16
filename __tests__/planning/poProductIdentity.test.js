const test = require("node:test");
const assert = require("node:assert/strict");
const { productIdentityKey } = require("../../services/poProductService");

const po = (over = {}) => ({
  skuCode: "SKU-1",
  modelName: "GB429",
  vendorId: "JSD",
  deviceCategory: { id: 1, name: "GB429" },
  esim: { make: "JIONET", profile1: "ARWEE", profile2: "BSNL" },
  firmware: { id: 1, name: "Basic" },
  configuration: { values: { ip: { id: "18", value: "act.gpsbox.co.in" }, port: { id: "19", value: "9001" } } },
  ...over,
});

test("a PO without a SKU has no identity, so no product is ever reused for it", () => {
  assert.equal(productIdentityKey(po({ skuCode: "" })), null);
  assert.equal(productIdentityKey(po({ skuCode: undefined })), null);
  assert.equal(productIdentityKey(po({ skuCode: "   " })), null);
  assert.equal(productIdentityKey(null), null);
});

test("POs of the same SKU and configuration share one identity, whatever their number, quantity or who raised them", () => {
  const a = productIdentityKey(po({ poNumber: "PO-1", requiredQuantity: 300, raisedBy: { name: "A" } }));
  const b = productIdentityKey(po({ poNumber: "PO-2", requiredQuantity: 5000, raisedBy: { name: "B" }, expectedDeliveryDate: "2026-12-01" }));
  assert.equal(a, b);
  assert.ok(a.startsWith("SKU-1|"));
});

test("anything a testing-plan slug can read changes the identity", () => {
  const base = productIdentityKey(po());
  const changed = {
    sku: po({ skuCode: "SKU-2" }),
    "a configuration value": po({ configuration: { values: { ip: { id: "18", value: "other.example.com" }, port: { id: "19", value: "9001" } } } }),
    "an added configuration value": po({ configuration: { values: { ip: { value: "act.gpsbox.co.in" }, port: { value: "9001" }, extra: { value: "1" } } } }),
    vendor: po({ vendorId: "OTHER" }),
    "eSIM make": po({ esim: { make: "OTHER", profile1: "ARWEE", profile2: "BSNL" } }),
    "eSIM profile 1": po({ esim: { make: "JIONET", profile1: "X", profile2: "BSNL" } }),
    "eSIM profile 2": po({ esim: { make: "JIONET", profile1: "ARWEE", profile2: "Airtel" } }),
    model: po({ modelName: "GB440" }),
    category: po({ deviceCategory: { id: 2, name: "GB440" } }),
    firmware: po({ firmware: { id: 2, name: "Pro" } }),
  };
  Object.entries(changed).forEach(([what, p]) => assert.notEqual(productIdentityKey(p), base, `${what} must give a different identity`));
});

test("the order of configuration values and the type of an id do not matter", () => {
  const a = productIdentityKey(po({ configuration: { values: { ip: { value: "1" }, port: { value: "2" } } } }));
  const b = productIdentityKey(po({ configuration: { values: { port: { value: "2" }, ip: { value: "1" } } } }));
  assert.equal(a, b);
  assert.equal(productIdentityKey(po({ deviceCategory: { id: 1 } })), productIdentityKey(po({ deviceCategory: { id: "1" } })));
  assert.equal(productIdentityKey(po({ configuration: { values: { ip: { id: "1", value: "x" } } } })), productIdentityKey(po({ configuration: { values: { ip: { id: "99", value: "x" } } } })), "the id of a value is not part of what it is");
});

test("a configuration given as a Map, or missing, is handled", () => {
  const asMap = productIdentityKey(po({ configuration: { values: new Map([["ip", { value: "1" }]]) } }));
  assert.equal(asMap, productIdentityKey(po({ configuration: { values: { ip: { value: "1" } } } })));
  assert.equal(productIdentityKey(po({ configuration: undefined })).split("|")[1], "none");
  assert.equal(productIdentityKey(po({ configuration: { values: {} } })).split("|")[1], "none");
  assert.equal(productIdentityKey(po({ configuration: { values: null } })).split("|")[1], "none");
});
