// Per-provider defaults used when a product step's actionType is "ESIM Settings".
// Add a new key here (and to the esimProvider enum in models/Products.js) to
// onboard a customer-specific provider.
const ESIM_PROVIDERS = {
  jsd: {
    label: "JSD",
    apn1: "iot.com",
    apn2: "bsnlnet",
    switchPf2Cmd: "+#SWITCHPF2;",
    switchPf1Cmd: "+#SWITCHPF1;",
  },
};

module.exports = { ESIM_PROVIDERS };
