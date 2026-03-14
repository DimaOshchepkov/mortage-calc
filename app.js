function getDefaultForm() {
  return {
    propertyPrice: 6_000_000,
    downPayment: 1_250_000,
    loanRate: 6,
    loanYears: 30,
    investRate: 15,
    inflation: 13,
    strategy: "invest",
    spouse1: {
      incomeMonthly: 90_000,
      ndflRate: 13,
      extraPercent: 20,
      purchaseDeduction: true,
      interestDeduction: true,
      iisDeduction: true,
    },
    spouse2: {
      incomeMonthly: 0,
      ndflRate: 13,
      extraPercent: 20,
      purchaseDeduction: false,
      interestDeduction: false,
      iisDeduction: false,
    },
  };
}

function getDefaultSummary() {
  return {
    loanAmount: 0,
    basePayment: 0,
    closeMonth: null,
    closeLabel: "",
    totalRefunds: 0,
    totalInterestPaid: 0,
    realInvestRateLabel: "",
    realLoanRateLabel: "",
  };
}

function fmtCurrency(value) {
  const num = Number(value || 0);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(num);
}

function formatCloseLabel(month) {
  const years = Math.floor((month - 1) / 12);
  const months = ((month - 1) % 12) + 1;

  if (years <= 0) {
    return `${months} мес.`;
  }

  return `${years} г. ${months} мес.`;
}

function annuityPayment(principal, monthlyRate, months) {
  if (months <= 0 || principal <= 0) return 0;
  if (monthlyRate === 0) return principal / months;

  const factor = Math.pow(1 + monthlyRate, months);

  return (principal * (monthlyRate * factor)) / (factor - 1);
}

function buildCalculationConstants(form) {
  const IIS_ANNUAL_CAP = 400_000;

  const loanAmount = Math.max(0, form.propertyPrice - form.downPayment);
  const totalMonths = Math.max(1, Math.round(form.loanYears * 12));
  const loanRateMonthly = form.loanRate / 100 / 12;
  const investRateMonthly = form.investRate / 100 / 12;
  const inflationFactor = 1 + form.inflation / 100;
  const basePayment = annuityPayment(loanAmount, loanRateMonthly, totalMonths);

  const realInvestRate =
    ((1 + form.investRate / 100) / inflationFactor - 1) * 100;
  const realLoanRate = ((1 + form.loanRate / 100) / inflationFactor - 1) * 100;

  return {
    IIS_ANNUAL_CAP,
    loanAmount,
    totalMonths,
    loanRateMonthly,
    investRateMonthly,
    inflationFactor,
    basePayment,
    realInvestRate,
    realLoanRate,
    horizonMonths: Math.max(totalMonths, 720),
  };
}

function buildInitialState(form, constants) {
  return {
    balance: constants.loanAmount,
    payment: constants.basePayment,
    capital: 0,
    totalRefunds: 0,
    totalInterestPaid: 0,
    totalPrincipalPaid: 0,
    closeMonth: null,
    closeLabel: "",
    rows: [],
    income1: form.spouse1.incomeMonthly,
    income2: form.spouse2.incomeMonthly,
    yearAccruedInterest: 0,
    prevYearInterestPaid: 0,
    calcYear: 1,
    monthInYear: 0,
    horizonMonths: constants.horizonMonths,
  };
}

function buildSpouses(form) {
  return [
    {
      getNdflRate: () => form.spouse1.ndflRate / 100,
      getExtraPercent: () => form.spouse1.extraPercent / 100,
      purchaseDeduction: form.spouse1.purchaseDeduction,
      interestDeduction: form.spouse1.interestDeduction,
      iisDeduction: form.spouse1.iisDeduction,
      remainingPurchaseBase: form.spouse1.purchaseDeduction ? 2_000_000 : 0,
      remainingInterestBase: form.spouse1.interestDeduction ? 3_000_000 : 0,
      ndflAccruedYear: 0,
      iisContribYear: 0,
      pendingIisContribPrevYear: 0,
    },
    {
      getNdflRate: () => form.spouse2.ndflRate / 100,
      getExtraPercent: () => form.spouse2.extraPercent / 100,
      purchaseDeduction: form.spouse2.purchaseDeduction,
      interestDeduction: form.spouse2.interestDeduction,
      iisDeduction: form.spouse2.iisDeduction,
      remainingPurchaseBase: form.spouse2.purchaseDeduction ? 2_000_000 : 0,
      remainingInterestBase: form.spouse2.interestDeduction ? 3_000_000 : 0,
      ndflAccruedYear: 0,
      iisContribYear: 0,
      pendingIisContribPrevYear: 0,
    },
  ];
}

function createMonthContext(month, date) {
  return {
    month,
    date,
    noteParts: [],
    refundReceivedMonth: 0,
    availableIisRefundMonth: 0,
    availablePurchaseRefundMonth: 0,
    availableInterestRefundMonth: 0,
  };
}

function markCloseIfNeeded(state, remainingDebt, month, monthContext, note) {
  const EPS = 0.01;

  if (state.closeMonth !== null) return;
  if (remainingDebt > EPS) return;

  state.balance = 0;
  state.closeMonth = month;
  state.closeLabel = formatCloseLabel(month);

  if (note) {
    monthContext.noteParts.push(note);
  }
}

function processYearStart(
  form,
  state,
  spouses,
  constants,
  month,
  monthContext,
) {
  if (state.monthInYear !== 1 || month <= 1) return;

  state.income1 *= constants.inflationFactor;
  state.income2 *= constants.inflationFactor;
  monthContext.noteParts.push("Индексирован доход на инфляцию");

  let refundReceived = 0;
  let availableIisRefund = 0;
  let availablePurchaseRefund = 0;
  let availableInterestRefund = 0;

  const interestReceivers = spouses.filter(
    (spouse) => spouse.interestDeduction,
  );
  const interestShareBase = interestReceivers.length
    ? state.prevYearInterestPaid / interestReceivers.length
    : 0;

  spouses.forEach((spouse) => {
    let refundBudget = spouse.ndflAccruedYear;
    const ndflRate = spouse.getNdflRate();

    if (spouse.iisDeduction && refundBudget > 0) {
      const base = Math.min(
        constants.IIS_ANNUAL_CAP,
        spouse.pendingIisContribPrevYear,
      );
      const got = Math.min(refundBudget, base * ndflRate);

      refundBudget -= got;
      refundReceived += got;
      availableIisRefund += got;
    }

    if (
      spouse.purchaseDeduction &&
      spouse.remainingPurchaseBase > 0 &&
      refundBudget > 0
    ) {
      const baseUsed = Math.min(
        spouse.remainingPurchaseBase,
        refundBudget / ndflRate,
      );
      const got = baseUsed * ndflRate;

      spouse.remainingPurchaseBase -= baseUsed;
      refundBudget -= got;
      refundReceived += got;
      availablePurchaseRefund += got;
    }

    if (
      spouse.interestDeduction &&
      spouse.remainingInterestBase > 0 &&
      refundBudget > 0
    ) {
      const eligibleBase = Math.min(
        spouse.remainingInterestBase,
        interestShareBase,
      );
      const baseUsed = Math.min(eligibleBase, refundBudget / ndflRate);
      const got = baseUsed * ndflRate;

      spouse.remainingInterestBase -= baseUsed;
      refundBudget -= got;
      refundReceived += got;
      availableInterestRefund += got;
    }

    spouse.ndflAccruedYear = 0;
    spouse.pendingIisContribPrevYear = spouse.iisContribYear;
    spouse.iisContribYear = 0;
  });

  state.prevYearInterestPaid = state.yearAccruedInterest;
  state.yearAccruedInterest = 0;
  state.calcYear += 1;

  monthContext.refundReceivedMonth = refundReceived;
  monthContext.availableIisRefundMonth = availableIisRefund;
  monthContext.availablePurchaseRefundMonth = availablePurchaseRefund;
  monthContext.availableInterestRefundMonth = availableInterestRefund;

  if (refundReceived <= 0) return;

  monthContext.noteParts.push("Получен возврат НДФЛ за прошлый год");
  state.totalRefunds += refundReceived;

  if (form.strategy === "invest") {
    state.capital += refundReceived;
    return;
  }

  const directed = Math.min(refundReceived, state.balance);
  state.balance -= directed;
  state.totalPrincipalPaid += directed;

  markCloseIfNeeded(
    state,
    state.balance,
    month,
    monthContext,
    "Ипотека закрыта возвратом НДФЛ",
  );
}

function accrueMonthlyNdfl(state, spouses) {
  const ndfl1 = state.income1 * spouses[0].getNdflRate();
  const ndfl2 = state.income2 * spouses[1].getNdflRate();

  spouses[0].ndflAccruedYear += ndfl1;
  spouses[1].ndflAccruedYear += ndfl2;

  return { ndfl1, ndfl2 };
}

function processRegularMortgagePayment(state, constants) {
  let interest = 0;
  let principal = 0;
  let regularPayment = 0;

  if (state.balance > 0) {
    interest = state.balance * constants.loanRateMonthly;
    principal = state.payment - interest;

    if (principal < 0) principal = 0;
    if (principal > state.balance) principal = state.balance;

    regularPayment = interest + principal;
    state.balance -= principal;
    state.totalInterestPaid += interest;
    state.totalPrincipalPaid += principal;
    state.yearAccruedInterest += interest;
  }

  return { interest, principal, regularPayment };
}

function processStrategyFlow(form, state, spouses, month, monthContext) {
  const invest1 = state.income1 * spouses[0].getExtraPercent();
  const invest2 = state.income2 * spouses[1].getExtraPercent();
  let prepayment = 0;

  if (form.strategy === "invest") {
    state.capital += invest1 + invest2;

    if (spouses[0].iisDeduction) spouses[0].iisContribYear += invest1;
    if (spouses[1].iisDeduction) spouses[1].iisContribYear += invest2;
  } else if (state.balance > 0) {
    prepayment = Math.min(invest1 + invest2, state.balance);
    state.balance -= prepayment;
    state.totalPrincipalPaid += prepayment;

    markCloseIfNeeded(
      state,
      state.balance,
      month,
      monthContext,
      "Ипотека закрыта досрочным погашением",
    );
  }

  return { invest1, invest2, prepayment };
}

function applyInvestmentYield(state, constants) {
  const investYield = state.capital * constants.investRateMonthly;
  state.capital += investYield;
  return investYield;
}

function markCloseByCapital(form, state, month, monthContext) {
  if (
    form.strategy === "invest" &&
    state.capital >= state.balance &&
    state.closeMonth === null
  ) {
    state.closeMonth = month;
    state.closeLabel = formatCloseLabel(month);
    monthContext.noteParts.push("Накопления сравнялись с остатком долга");
  }
}

function buildRow(
  form,
  state,
  monthContext,
  paymentResult,
  strategyResult,
  investYield,
) {
  const { interest, principal, regularPayment, ndfl1, ndfl2 } = paymentResult;
  const { invest1, invest2, prepayment } = strategyResult;

  return {
    month: monthContext.month,
    date: monthContext.date.toLocaleDateString("ru-RU", {
      year: "numeric",
      month: "2-digit",
    }),
    year: state.calcYear,
    monthInYear: state.monthInYear,
    income1: state.income1,
    income2: state.income2,
    ndfl1,
    ndfl2,
    payment:
      form.strategy === "prepay" ? regularPayment + prepayment : regularPayment,
    interest,
    principal,
    prepayment,
    balance: state.balance,
    invest1: form.strategy === "invest" ? invest1 : 0,
    invest2: form.strategy === "invest" ? invest2 : 0,
    investYield,
    refundReceived: monthContext.refundReceivedMonth,
    capital: state.capital,
    availableIisRefund: monthContext.availableIisRefundMonth,
    availablePurchaseRefund: monthContext.availablePurchaseRefundMonth,
    availableInterestRefund: monthContext.availableInterestRefundMonth,
    note: monthContext.noteParts.join("; "),
  };
}

function buildSummary(state, constants) {
  return {
    loanAmount: constants.loanAmount,
    basePayment: constants.basePayment,
    closeMonth: state.closeMonth,
    closeLabel: state.closeLabel,
    totalRefunds: state.totalRefunds,
    totalInterestPaid: state.totalInterestPaid,
    realInvestRateLabel: `Реальный доход инвестиций: ${constants.realInvestRate.toFixed(2)}%`,
    realLoanRateLabel: `Реальный процент ипотеки: ${constants.realLoanRate.toFixed(2)}%`,
  };
}

function calculateMortgage(form) {
  const constants = buildCalculationConstants(form);
  const state = buildInitialState(form, constants);
  const spouses = buildSpouses(form);

  for (let month = 1; month <= state.horizonMonths; month++) {
    if (state.balance <= 0) break;

    state.monthInYear += 1;

    const date = new Date(2026, 0, 1);
    date.setMonth(date.getMonth() + month - 1);

    const monthContext = createMonthContext(month, date);

    processYearStart(form, state, spouses, constants, month, monthContext);

    if (state.balance <= 0) {
      markCloseIfNeeded(
        state,
        state.balance,
        month,
        monthContext,
        "Ипотека закрыта возвратом НДФЛ",
      );

      state.rows.push(
        buildRow(
          form,
          state,
          monthContext,
          {
            interest: 0,
            principal: 0,
            regularPayment: 0,
            ndfl1: 0,
            ndfl2: 0,
          },
          {
            invest1: 0,
            invest2: 0,
            prepayment: 0,
          },
          0,
        ),
      );

      break;
    }

    const ndflResult = accrueMonthlyNdfl(state, spouses);
    const paymentResult = processRegularMortgagePayment(state, constants);

    markCloseIfNeeded(
      state,
      state.balance,
      month,
      monthContext,
      "Ипотека закрыта плановым платежом",
    );

    let strategyResult = {
      invest1: 0,
      invest2: 0,
      prepayment: 0,
    };

    let investYield = 0;

    if (state.balance > 0) {
      strategyResult = processStrategyFlow(
        form,
        state,
        spouses,
        month,
        monthContext,
      );

      investYield = applyInvestmentYield(state, constants);
      markCloseByCapital(form, state, month, monthContext);
    }

    state.rows.push(
      buildRow(
        form,
        state,
        monthContext,
        {
          ...paymentResult,
          ...ndflResult,
        },
        strategyResult,
        investYield,
      ),
    );

    if (state.monthInYear === 12) {
      state.monthInYear = 0;
    }
  }

  return {
    rows: state.rows,
    summary: buildSummary(state, constants),
  };
}

function downloadRowsCsv(rows) {
  if (!rows.length) return;

  const headers = [
    "month",
    "date",
    "year",
    "monthInYear",
    "income1",
    "income2",
    "ndfl1",
    "ndfl2",
    "payment",
    "interest",
    "principal",
    "prepayment",
    "balance",
    "invest1",
    "invest2",
    "investYield",
    "refundReceived",
    "capital",
    "availableIisRefund",
    "availablePurchaseRefund",
    "availableInterestRefund",
    "note",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(
      headers
        .map((header) => `"${String(row[header] ?? "").replaceAll('"', '""')}"`)
        .join(","),
    );
  }

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "mortgage_calculation.csv";
  link.click();

  URL.revokeObjectURL(url);
}

function mortgageApp() {
  return {
    view: "table",
    form: getDefaultForm(),
    rows: [],
    summary: getDefaultSummary(),

    init() {
      this.recalculate();
    },

    resetDefaults() {
      this.form = getDefaultForm();
      this.recalculate();
    },

    fmt(value) {
      return fmtCurrency(value);
    },

    recalculate() {
      const result = calculateMortgage(this.form);
      this.rows = result.rows;
      this.summary = result.summary;
    },

    downloadCsv() {
      downloadRowsCsv(this.rows);
    },
  };
}
