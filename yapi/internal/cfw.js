const fs = require('fs')
const superagent = require('superagent');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const format = require('string-template')




exports.installWorker = (req, res) => {
  const vResult = validationResult(req);
  const hasErrors = !vResult.isEmpty();
  if (hasErrors) {
      return res.status(402).json(vResult.errors);
  }

  const scriptBase64 = req.body.script64
  const cfEmail  = req.body.cfEmail
  const cfKey = req.body.cfKey

  let scriptString;

  try {
    const buffer = Buffer.from(scriptBase64, 'base64');
    scriptString =  buffer.toString('utf-8');
  } catch (e) {
    console.error('Error decoding base64 string:', e);

    return res.json({
      status: "Error",
      error: 'Invalid Script',
      code: 1,
      message: "'Error decoding Worker Script:'",
    })
  }

  
  const cf = {
    scriptName: crypto.randomBytes(4).toString('hex'),
    script: scriptString,
    email: cfEmail,
    apiKey: cfKey
  }

  addWorkerScript(cf, (err, workerUrl) => {

    if (err) {
      console.error(err.response);
      return res.json({
        status: "Error",
        error: 'Add Script Error',
        code: 1,
        message: "'Error Uploading Worker Script, Is Your Account Valid?'",
      })
    }


    let userFileObj = JSON.parse(fs.readFileSync('./nkp/config/user.json'))
    userFileObj.CF_WORKER_URL = workerUrl

    fs.writeFileSync('./nkp/config/user.json', JSON.stringify(userFileObj, '', 4))


    return res.json({
      status: "Success",
      error: null,
      code: 0,
      message: 'Successfully Added Worker Script',
      info: {url: workerUrl},
    })
  })
  

}

exports.removeWorker = (req, res) => {

  let userFileObj = JSON.parse(fs.readFileSync('./nkp/config/user.json'))
  userFileObj.CF_WORKER_URL = ''

    fs.writeFileSync('./nkp/config/user.json', JSON.stringify(userFileObj, '', 4))


    return res.json({
      status: "Success",
      error: null,
      code: 0,
      message: 'Successfully Removed Cloudflare Worker Script',
      info: 'Deleted Cloudflare Worker',
    })
}

function getAccountId(cf,  callback) {
  superagent
    .get('https://api.cloudflare.com/client/v4/accounts')
    .set('X-Auth-Email', cf.email)
    .set('X-Auth-Key', cf.apiKey)
    .end((error, response) => {
      if (error) {
        callback(error, null);
      } else {
        callback(null, response.body.result[0].id);
      }
    });
}


function deleteAllWorkers(cf, accountId,  callback) { 
    superagent
      .get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`)
      .set('X-Auth-Email', cf.email)
      .set('X-Auth-Key', cf.apiKey)
      .end((error, response) => {
        if (error) {
          callback(error, null);
        } else {
          const workerIDs = response.body.result.map(worker => worker.id);
          if (workerIDs.length < 5) {
            return callback(null, true);
          }
          const deletePromises = workerIDs.map(id =>
          superagent
          .delete(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${id}`)
          .set('X-Auth-Email', cf.email)
          .set('X-Auth-Key', cf.apiKey)
          );

          Promise.all(deletePromises)
          .then(() => {
            callback(null, true);
          })
          .catch(error => {
            callback(error, false)
          })
        
        }
      });
}


function getOrMakeSubdomain(cf, accountId, callback) {
  let subdomainChar = ''
  superagent.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`)
    .set('X-Auth-Email', cf.email)
    .set('X-Auth-Key', cf.apiKey)
    .end((error, response) => {
        if (response.body.result) {
            subdomainChar = response.body.result.subdomain
            callback(false, subdomainChar)
          } else {
            const sName = crypto.randomBytes(12).toString('hex')
          
            superagent.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`)
              .set('X-Auth-Email', cf.email)
              .set('X-Auth-Key', cf.apiKey)
              .send({subdomain: sName})
              .end((error, response) => {
                if (error) {
                  callback(error, false);
                } else {
                  let subdomainChar = response.body.result.subdomain
                  callback(false, subdomainChar)

                }

              })

          }
  })
                      

}


function getOrMakeTurnStile(cf, accountId, subdomainID, callback) {
  let subdomainChar = ''
  const workerSubdomain = `${subdomainID}.worker.dev`

  const makeTurnStile = () => {
    superagent.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets`)
      .set('X-Auth-Email', cf.email)
      .set('X-Auth-Key', cf.apiKey)
      .send({
        // bot_fight_mode: true,
        domains: [workerSubdomain],
        mode: 'managed',
        name: `${subdomainID} captcha form`,
        region: 'world'
      })
      .end((error, response) => {
        if (error) {
          callback(error, false);
        } else {
          const siteKey = response.body.result.sitekey
          const secret = response.body.result.secret
          callback(false, { secret, siteKey })

        }
    })

  }

  superagent.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets`)
    .set('X-Auth-Email', cf.email)
    .set('X-Auth-Key', cf.apiKey)
    .end((error, response) => {
        if (response.body.result) {
            let matchingSiteKey
            let domainList
            for (let widget of response.body.result) {
              if (widget.domains && widget.domains.includes(workerSubdomain)) {
                  matchingSiteKey = widget.sitekey;
                  domainList = widget.domains
                  break; 
              }
            }

            if (matchingSiteKey) {
              superagent.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets/${matchingSiteKey}`)
                .set('X-Auth-Email', cf.email)
                .set('X-Auth-Key', cf.apiKey)
                .end((error, response) => {

                  if (response.body.result) {
                    const siteKey = response.body.result.sitekey
                    const secret = response.body.result.secret
                    callback(false, { secret, siteKey, domainList  })
                  } else {
                    makeTurnStile()
                  }
                })
              
            } else {
              makeTurnStile()
            }
           
          } else {          
            makeTurnStile()
          }
  })
                      

}

function getRedirectUrl() {
  let redirectUrl

    let userFileObj = JSON.parse(fs.readFileSync('./nkp/config/user.json'))
    const srcKey = userFileObj.SRC_KEY


    const sslFileObj = JSON.parse(fs.readFileSync('./nkp/config/ssl.json'))
    sslFileObj.forEach(sslInfo =>  {
        const formattedLink = `https://${sslInfo.domain}/?${srcKey}`
        if (sslInfo.isRedirect) {
            redirectUrl = formattedLink
        }
        
    })

    return redirectUrl
}

function addWorkerScript(cf, callback) {
  const redirectUrl = getRedirectUrl()
  
  getAccountId(cf, (error, accountId) => {
    if (error) {
      callback(error, null);
    } else {
      getOrMakeSubdomain(cf, accountId, (error, subdomainValue) => {
        if (error) {
          callback(error, null);
        } else {
          getOrMakeTurnStile(cf, accountId, subdomainValue, (error, siteData) => {
            if (error) {
              callback(error, null);
            } else {
              const scriptStr = format(cf.script, {ENDPOINT: redirectUrl,
                 SITEKEY: siteData.siteKey, SECRETKEY: siteData.secret})

              // console.log(scriptStr)
              // return callback('errroxxxx', null)
             
              superagent
              .put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${cf.scriptName}`)
              .set('X-Auth-Email', cf.email)
              .set('X-Auth-Key', cf.apiKey)
              .field('metadata', JSON.stringify({"main_module": "worker.js"}))
              .attach('worker.js', Buffer.from(scriptStr, 'utf8'), 
                {filename: 'worker.js', contentType: 'application/javascript+module'})
    
              .end((error, response) => {
                  if (error) {
                    callback(error, null);
                  } else {
                    const deploymentID = response.body.result.id
                    superagent.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${cf.scriptName}/subdomain`)
                    .set('X-Auth-Email', cf.email)
                    .set('X-Auth-Key', cf.apiKey)
                    .send({enabled: true})
                    .end((error, response) => {
                        if (error) {
                          callback(error, null);
                        } else {
                          const targetDomain = `${deploymentID}.${subdomainValue}.workers.dev`
                          let domainTargets = [targetDomain]

                          if (siteData.domainList) {
                            domainTargets.push(...siteData.domainList)
                          }

                          superagent.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets/${siteData.siteKey}`)
                          .set('X-Auth-Email', cf.email)
                          .set('X-Auth-Key', cf.apiKey)
                          .send({
                            domains: domainTargets,
                            mode: 'managed',
                            name: `final-captcha form`,
                          })
                          .end((error, response) => {
                            if (error) {
                              callback(error, false);
                            } else {
                              const targetUrl = `https://${targetDomain}`
                              return callback(null, targetUrl);

                    
                            }
                          })
                          
                        }
                      })
                    
                  }
                });
            }
          });

        }
      })
    }
  });

}

