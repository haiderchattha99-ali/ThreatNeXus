function calculateRiskScore(severity) {
    switch ((severity || "").toLowerCase()) {
        case "critical":
            return 100;

        case "high":
            return 90;

        case "medium":
            return 60;

        case "low":
            return 25;

        default:
            return 0;
    }
}

module.exports = {
    calculateRiskScore
};