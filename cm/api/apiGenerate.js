import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import fs from "fs-extra";
import path from "path";
import {
    v4 as uuid
} from "uuid";
import moment from "moment";
import generateData from "./data/generate.json";
import Mailer from "../../../shared/lib/mailer";
import Utils from "./utils";
import calc from "./calc";
import Cyr from "./cyr";

const utils = new Utils();
const cyr = new Cyr();

export default () => ({
    schema: {
        body: generateData.schema
    },
    attachValidation: true,
    async handler(req) {
        const {
            log,
            response,
            auth,
        } = req.zoia;
        // Check permissions
        if (!auth.checkStatus("active")) {
            response.unauthorizedError();
            return;
        }
        // Validate form
        if (req.validationError) {
            log.error(null, req.validationError ? req.validationError.message : "Request Error");
            response.validationError(req.validationError || {});
            return;
        }
        try {
            const cmData = await this.mongo.db.collection(req.zoiaConfig.collections.registry).findOne({
                _id: "cm_data"
            });
            if (!cmData || !cmData.config || !cmData.config.holdings || !auth.checkGroup("cm")) {
                response.requestError({
                    failed: true,
                    error: "Configuration not found",
                    errorKeyword: "noConfig",
                    errorData: []
                });
                return;
            }
            let userHolding;
            Object.keys(cmData.config.holdings).map(h => {
                if (auth.checkGroup(h)) {
                    userHolding = h;
                }
            });
            if (!userHolding || !cmData.config.holdings[userHolding] || req.body.room > cmData.config.holdings[userHolding].rooms.length) {
                response.requestError({
                    failed: true,
                    error: "Holding not found",
                    errorKeyword: "noHolding",
                    errorData: []
                });
                return;
            }
            const holdingData = cmData.config.holdings[userHolding];
            const cardId = holdingData.cards[req.body.cardType - 1].id;
            const templateCertPath = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryTemplates}/${cardId}.docx`);
            const templateCertData = await fs.readFile(templateCertPath, "binary");
            const dataCertZip = new PizZip(templateCertData);
            const templateCertDoc = new Docxtemplater();
            templateCertDoc.loadZip(dataCertZip);
            const templateAnnexPath = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryTemplates}/legacy_annex.docx`);
            const templateAnnexData = await fs.readFile(templateAnnexPath, "binary");
            const dataAnnexZip = new PizZip(templateAnnexData);
            const templateAnnexDoc = new Docxtemplater();
            templateAnnexDoc.loadZip(dataAnnexZip);
            const [dateDD, dateMM, dateYYYY] = req.body.date.split(/\./);
            const dateStringMM = cyr.getRuMonthString(dateMM);
            const years = (req.body.years ? parseInt(req.body.years, 10) : 1) || 1;
            const months = (req.body.creditMonths ? parseInt(req.body.creditMonths, 10) : 1) || 1;
            const price = cardId.match(/^fox/) ? parseInt(req.body.price * years, 10) : parseInt(req.body.price, 10);
            const holdingTitle = cmData.config.holdings[userHolding].title;
            let components = [];
            let componentsOfficeCost;
            let componentsTotalCost;
            let rangeIndex = 0;
            let annexData = {};
            let {
                cardNumber
            } = req.body;
            let certIndex = 0;
            // Check legacy fields
            if (cardId === "legacy") {
                if (!cmData.config.legacy.hideCreditSum && !cmData.config.legacy.noCredit && (!req.body.creditMonths || months < 1)) {
                    response.requestError({
                        failed: true,
                        error: "Invalid months value",
                        errorKeyword: "invalidMonths",
                        errorData: [{
                            keyword: "invalidMonths",
                            dataPath: ".creditMonths"
                        }]
                    });
                    return;
                }
                if (!cmData.config.legacy.hideCreditSum && !cmData.config.legacy.noCredit && (!req.body.creditSum || req.body.creditSum < 1)) {
                    response.requestError({
                        failed: true,
                        error: "Invalid credit sum",
                        errorKeyword: "invalidCreditSum",
                        errorData: [{
                            keyword: "invalidCreditSum",
                            dataPath: ".creditSum"
                        }]
                    });
                    return;
                }
                if (cmData.config.legacy && cmData.config.legacy.manualPrice && !req.body.price) {
                    response.requestError({
                        failed: true,
                        error: "Invalid price",
                        errorKeyword: "invalidPrice",
                        errorData: [{
                            keyword: "invalidPrice",
                            dataPath: ".price"
                        }]
                    });
                    return;
                }
                if (!cmData.config.legacy.hideCreditSum && !cmData.config.legacy.noCredit && (!req.body.creditPercentage || req.body.creditPercentage < 1)) {
                    response.requestError({
                        failed: true,
                        error: "Invalid credit percents value",
                        errorKeyword: "invalidCreditPercentage",
                        errorData: [{
                            keyword: "invalidCreditPercentage",
                            dataPath: ".creditPercentage"
                        }]
                    });
                    return;
                }
                let legacyPrice;
                if (cmData.config.legacy && cmData.config.legacy.manualPrice) {
                    legacyPrice = req.body.price;
                }
                const calcData = calc.legacy(cmData.config.legacy.ranges, cmData.config.legacy.components, req.body.creditSum, months, req.body.creditPercentage, legacyPrice, req.body.first10, cmData.config.legacy.minFreeComponentsCost);
                componentsTotalCost = calcData.productCost;
                componentsOfficeCost = calcData.office;
                rangeIndex = calcData.rangeIndex;
                components = calcData.components;
                annexData = calcData.annexData;
                const counterData = await this.mongo.db.collection(req.zoiaConfig.collections.counters).findOneAndUpdate({
                    _id: "cmLegacy"
                }, {
                    $inc: {
                        value: 1
                    },
                }, {
                    upsert: true
                });
                if (!counterData || counterData.ok !== 1 || !counterData.value || !counterData.value.value) {
                    response.requestError({
                        failed: true,
                        error: "Could not get Legacy counter value",
                        errorKeyword: "legacyCounterError",
                        errorData: []
                    });
                    return;
                }
                cardNumber = `00${counterData.value.value}`;
                certIndex = parseInt(counterData.value.value, 10)
            } else {
                // Check non-legacy fields
                if (!req.body.cardNumber || req.body.cardNumber < cmData.config.minCardNumber || req.body.cardNumber > cmData.config.maxCardNumber) {
                    response.requestError({
                        failed: true,
                        error: "Invalid card number",
                        errorKeyword: "invalidCardNumber",
                        errorData: [{
                            keyword: "invalidCardNumber",
                            dataPath: ".cardNumber"
                        }]
                    });
                    return;
                }
                if (!req.body.price || req.body.price < cmData.config.minCardPrice || req.body.price > cmData.config.maxCardPrice) {
                    response.requestError({
                        failed: true,
                        error: "Invalid price",
                        errorKeyword: "invalidPrice",
                        errorData: [{
                            keyword: "invalidPrice",
                            dataPath: ".price"
                        }]
                    });
                    return;
                }
                const existingData = await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmFiles).findOne({
                    cardNumber: req.body.cardNumber,
                    cardType: cardId
                });
                if (existingData) {
                    response.requestError({
                        failed: true,
                        error: "Card with such number already exists",
                        errorKeyword: "cardExists",
                        errorData: [{
                            keyword: "cardExists",
                            dataPath: ".cardNumber"
                        }]
                    });
                    return;
                }
            }
            let usernameLetter1;
            let usernameLetter2;
            if (rangeIndex < 27) {
                usernameLetter1 = "A";
            } else if (rangeIndex < 53) {
                usernameLetter1 = "B";
            } else {
                usernameLetter1 = "C";
            }
            if (rangeIndex < 27) {
                usernameLetter2 = String.fromCharCode(65 + rangeIndex);
            } else if (rangeIndex < 53) {
                usernameLetter2 = String.fromCharCode(65 + rangeIndex - 26);
            } else {
                usernameLetter2 = String.fromCharCode(65 + rangeIndex - 52);
            }
            const usernameHId = holdingData.id;
            const usernameRId = cmData.config.holdings[userHolding].roomsId[req.body.room - 1];
            const roomName = cmData.config.holdings[userHolding].rooms[req.body.room - 1];
            const accountUsername = `L${usernameLetter1}${usernameLetter2}${usernameHId}${usernameRId}${cardNumber}`;
            const accountPassword = `PC${parseInt(cardNumber, 10)}`;
            let serviceCodeAutoSchool = "—";
            if (cmData.config.legacy.ranges[rangeIndex].components.indexOf(5) > -1) {
                const codeRecordDrivingSchool = await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmCodes).findOneAndDelete({
                    codeType: "drivingSchool"
                }, {
                    sort: {
                        importDate: -1
                    }
                });
                serviceCodeAutoSchool = codeRecordDrivingSchool && codeRecordDrivingSchool.value && codeRecordDrivingSchool.value.code ? codeRecordDrivingSchool.value.code : Math.random().toString(36).slice(-8);
            }
            templateCertDoc.setData({
                customerName: req.body.customerName,
                customerBirthDate: req.body.customerBirthDate,
                customerAddress: req.body.customerAddress,
                customerPhone: cyr.formatPhoneNumber(String(req.body.customerPhone)),
                customerEmail: req.body.customerEmail,
                cardNumber,
                day: dateDD,
                month: dateMM,
                year: dateYYYY,
                dateStringMM,
                yearYY: `${dateYYYY[2]}${dateYYYY[3]}`,
                price: cyr.rubles(price),
                price475: cyr.rubles(((47.5 / 100) * price).toFixed(2)),
                price95: cyr.rubles(((95 / 100) * price).toFixed(2)),
                price5: cyr.rubles(((5 / 100) * price).toFixed(2)),
                years,
                months,
                yearsString: cyr.getRuAgeString(years),
                monthsString: cyr.getRuMonthsString(months),
                componentsTotalCost,
                components,
                componentsOfficeCost,
                accountUsername,
                accountPassword,
                serviceCodeAutoSchool,
                vin: typeof req.body.vin === "string" ? req.body.vin.toUpperCase() : "",
                creditStartDate: req.body.creditStartDate,
                creditEndDate: req.body.creditEndDate,
            });
            templateCertDoc.render();
            const templateBuf = templateCertDoc.getZip().generate({
                type: "nodebuffer"
            });
            const tempFilePath = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.tmp}/${uuid()}.docx`);
            await fs.writeFile(tempFilePath, templateBuf);
            const convertResult = await utils.convertDocxToPDF(tempFilePath, path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.tmp}`));
            await fs.remove(tempFilePath);
            if (!convertResult) {
                response.requestError({
                    failed: true,
                    error: "Could not convert file to PDF",
                    errorKeyword: "couldNotConvert",
                    errorData: []
                });
                return;
            }
            const uid = uuid();
            const saveFilename = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryFiles}/${uid}`);
            const stats = await fs.lstat(convertResult);
            await fs.move(convertResult, saveFilename);
            await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmFiles).updateOne({
                _id: uid
            }, {
                $set: {
                    name: `${userHolding}_${cardId}_${moment().format("DDMMYYYY_HHmm")}.pdf`,
                    size: stats.size,
                    date: new Date(),
                    cardNumber,
                    customerName: req.body.customerName,
                    holding: userHolding,
                    cardType: cardId,
                    username: auth.getUser()._id
                }
            }, {
                upsert: true
            });
            await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmStats).insertOne({
                certIndex,
                cardNumber,
                holdingTitle,
                roomName,
                date: new Date(),
                endDate: req.body.creditEndDate,
                cost: componentsTotalCost,
                customerName: req.body.customerName,
                customerAddress: req.body.customerAddress,
                vin: typeof req.body.vin === "string" ? req.body.vin.toUpperCase() : null,
            });
            let uidAnnex;
            if (Object.keys(annexData).length && cardId === "legacy") {
                templateAnnexDoc.setData(annexData);
                templateAnnexDoc.render();
                const templateAnnexBuf = templateAnnexDoc.getZip().generate({
                    type: "nodebuffer"
                });
                const tempAnnexFilePath = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.tmp}/${uuid()}.docx`);
                await fs.writeFile(tempAnnexFilePath, templateAnnexBuf);
                const convertAnnexResult = await utils.convertDocxToPDF(tempAnnexFilePath, path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.tmp}`));
                await fs.remove(tempAnnexFilePath);
                if (!convertAnnexResult) {
                    response.requestError({
                        failed: true,
                        error: "Could not convert file to PDF",
                        errorKeyword: "couldNotConvert",
                        errorData: []
                    });
                    return;
                }
                uidAnnex = uuid();
                const saveAnnexFilename = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryFiles}/${uidAnnex}`);
                const statsAnnex = await fs.lstat(convertAnnexResult);
                await fs.move(convertAnnexResult, saveAnnexFilename);
                await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmFiles).updateOne({
                    _id: uidAnnex
                }, {
                    $set: {
                        name: `${userHolding}_${cardId}_${moment().format("DDMMYYYY_HHmm")}_annex.pdf`,
                        size: statsAnnex.size,
                        date: new Date(),
                        cardNumber,
                        customerName: req.body.customerName,
                        holding: userHolding,
                        cardType: `${cardId} (приложение)`,
                        username: auth.getUser()._id
                    }
                }, {
                    upsert: true
                });
                if (cmData.config.legacy.techService) {
                    const techServicePath = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryTemplates}/tech_service.pdf`);
                    const uidTechService = uuid();
                    const saveTechServiceFilename = path.resolve(`${__dirname}/../../${req.zoiaConfig.directories.files}/${req.zoiaModulesConfig["cm"].directoryFiles}/${uidTechService}`);
                    const statsTechService = await fs.lstat(techServicePath);
                    await fs.copy(techServicePath, saveTechServiceFilename);
                    await this.mongo.db.collection(req.zoiaModulesConfig["cm"].collectionCmFiles).updateOne({
                        _id: uidTechService
                    }, {
                        $set: {
                            name: `${userHolding}_${cardId}_${moment().format("DDMMYYYY_HHmm")}_tech_service.pdf`,
                            size: statsTechService.size,
                            date: new Date(),
                            cardNumber,
                            customerName: req.body.customerName,
                            holding: userHolding,
                            cardType: `${cardId} (тех. сертификат)`,
                            username: auth.getUser()._id
                        }
                    }, {
                        upsert: true
                    });
                }
            }
            const mailer = new Mailer(this, "ru");
            await mailer.initMetadata();
            if (cardId === "legacy") {
                const cardIdAlias = cmData.config.legacy.cardTypeAlias || "Legacy";
                const cardIdLink = cmData.config.legacy.cardTypeLink || "https://legacycard.ru";
                const cardIdLinkText = cmData.config.legacy.cardTypeLinkText || "legacycard.ru";
                if (req.body.customerEmail) {
                    mailer.setRecipient(req.body.customerEmail);
                    mailer.setSubject(cardIdAlias);
                    mailer.setPreheader(`Ваш сертификат ${cardIdAlias}`);
                    // mailer.addAttachment(`${userHolding}_${cardId}.pdf`, saveFilename);
                    // HTML
                    mailer.setHTML(`
                ${this.mailTemplateComponentsHTML["paragraph"]({ text: `Благодарим вас за приобретение комплекса ${cardIdAlias}.`, style: "" })}
                ${this.mailTemplateComponentsHTML["paragraph"]({ text: `Вам доступны огромное количество юридических услуг и других компонентов ${cardIdAlias}. Подробнее обо всем этом вы можете узнать и воспользоваться ими на <a href="${cardIdLink}">${cardIdLinkText}</a>.`, style: "" })}
                ${this.mailTemplateComponentsHTML["paragraph"]({ text: `<strong>Имя пользователя:</strong>&nbsp;${accountUsername}<br><strong>Пароль:</strong>&nbsp;${accountPassword}`, style: "" })}
                `);
                    // Text
                    mailer.setText(`${this.mailTemplateComponentsText["paragraph"]({ text: `Благодарим вас за приобретение комплекса ${cardIdAlias}.` })}${this.mailTemplateComponentsText["paragraph"]({ text: `Вам доступны огромное количество юридических услуг и других компонентов ${cardIdAlias}. Подробнее обо всем этом вы можете узнать и воспользоваться ими на ${cardIdLink}.` })}${this.mailTemplateComponentsText["paragraph"]({ text: `Имя пользователя: ${accountUsername}\nПароль: ${accountPassword}` })}`, false);
                    mailer.addLogo();
                    mailer.sendMail();
                }
                mailer.setRecipient(cmData.config.legacy.mail || "client@legacycard.ru");
                mailer.setSubject(`Новый сертификат ${cardIdAlias}`);
                mailer.setPreheader(`Новый сертификат ${cardIdAlias}`);
                mailer.addAttachment(`${userHolding}_${cardId}.pdf`, saveFilename);
                // HTML
                mailer.setHTML(`
                ${this.mailTemplateComponentsHTML["paragraph"]({ text: "На сайте был выписан новый сертификат.", style: "" })}
                ${this.mailTemplateComponentsHTML["paragraph"]({ text: `<strong>Имя пользователя:</strong>&nbsp;${accountUsername}<br><strong>Пароль:</strong>&nbsp;${accountPassword}`, style: "" })}
                `);
                // Text
                mailer.setText(`${this.mailTemplateComponentsText["paragraph"]({ text: "На сайте был выписан новый сертификат." })}${this.mailTemplateComponentsText["paragraph"]({ text: `Имя пользователя: ${accountUsername}\nПароль: ${accountPassword}` })}`, false);
                mailer.addLogo();
                mailer.sendMail();
            }
            // Send result
            response.successJSON({
                uid,
                uidAnnex
            });
            return;
        } catch (e) {
            log.error(e);
            // eslint-disable-next-line consistent-return
            return Promise.reject(e);
        }
    }
});
