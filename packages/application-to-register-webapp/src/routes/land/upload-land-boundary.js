import { logger } from 'defra-logging-facade'
import { handleEvents } from '../../utils/azure-signalr.js'
import { uploadStreamAndQueueMessage } from '../../utils/azure-storage.js'
import constants from '../../utils/constants.js'
import { uploadFiles } from '../../utils/upload.js'

const LAND_BOUNDARY_ID = '#landBoundary'

function processSuccessfulUpload (result, request) {
  let resultView = constants.views.INTERNAL_SERVER_ERROR
  let errorMessage = {}
  if ((parseFloat(result.fileSize) * 100) === 0) {
    resultView = constants.views.UPLOAD_LAND_BOUNDARY
    errorMessage = {
      err: [{
        text: 'The selected file is empty',
        href: LAND_BOUNDARY_ID
      }]
    }
  } else if (result[0].errorMessage === undefined) {
    request.yar.set(constants.redisKeys.LAND_BOUNDARY_LOCATION, result[0].location)
    request.yar.set(constants.redisKeys.LAND_BOUNDARY_FILE_SIZE, result.fileSize)
    logger.log(`${new Date().toUTCString()} Received land boundary data for ${result[0].location.substring(result[0].location.lastIndexOf('/') + 1)}`)
    resultView = constants.routes.CHECK_LAND_BOUNDARY
  }
  return { resultView, errorMessage }
}

function processErrorUpload (err, h) {
  switch (err.message) {
    case constants.uploadErrors.noFile:
      return h.view(constants.views.UPLOAD_LAND_BOUNDARY, {
        err: [{
          text: 'Select a file showing the land boundary',
          href: LAND_BOUNDARY_ID
        }]
      })
    case constants.uploadErrors.unsupportedFileExt:
      return h.view(constants.views.UPLOAD_LAND_BOUNDARY, {
        err: [{
          text: 'The selected file must be a DOC, DOCX, JPG, PNG or PDF',
          href: LAND_BOUNDARY_ID
        }]
      })
    default:
      if (err.message.indexOf('timed out') > 0) {
        return h.redirect(constants.views.UPLOAD_LAND_BOUNDARY, {
          err: [{
            text: 'The selected file could not be uploaded -- try again',
            href: LAND_BOUNDARY_ID
          }]
        })
      }
      throw err
  }
}

function processReturnValue (details, h) {
  return details.resultView === constants.routes.CHECK_LAND_BOUNDARY
    ? h.redirect(details.resultView, details.errorMessage)
    : h.view(details.resultView, details.errorMessage)
}

const handlers = {
  get: async (_request, h) => h.view(constants.views.UPLOAD_LAND_BOUNDARY),
  post: async (request, h) => {
    const config = buildConfig(request.yar.id)
    return uploadFiles(logger, request, config).then(
      function (result) {
        const viewDetails = processSuccessfulUpload(result, request)
        return processReturnValue(viewDetails, h)
      },
      function (err) {
        return processErrorUpload(err, h)
      }
    ).catch(err => {
      console.log(`Problem uploading file ${err}`)
      return h.view(constants.views.UPLOAD_LAND_BOUNDARY, {
        err: [{
          text: 'The selected file could not be uploaded -- try again',
          href: LAND_BOUNDARY_ID
        }]
      })
    })
  }
}

const buildConfig = sessionId => {
  const config = {}
  buildBlobConfig(sessionId, config)
  buildQueueConfig(config)
  buildFunctionConfig(config)
  buildSignalRConfig(sessionId, config)
  buildFileValidationConfig(config)
  return config
}

const buildBlobConfig = (sessionId, config) => {
  config.blobConfig = {
    blobName: `${sessionId}/landBoundary/`,
    containerName: 'untrusted',
    metadata: {
      noprocess: 'true' // metadata to stop file being sent on for post processing
    }
  }
}

const buildQueueConfig = config => {
  config.queueConfig = {
    uploadType: constants.uploadTypes.LAND_BOUNDARY_UPLOAD_TYPE,
    queueName: 'untrusted-file-queue'
  }
}

const buildFunctionConfig = config => {
  config.functionConfig = {
    uploadFunction: uploadStreamAndQueueMessage,
    handleEventsFunction: handleEvents
  }
}

const buildSignalRConfig = (sessionId, config) => {
  config.signalRConfig = {
    eventProcessingFunction: null,
    timeout: parseInt(process.env.UPLOAD_PROCESSING_TIMEOUT_MILLIS) || 180000,
    url: `${process.env.SIGNALR_URL}?userId=${sessionId}`
  }
}

const buildFileValidationConfig = config => {
  config.fileValidationConfig = {
    fileExt: constants.landBoundaryFileExt
  }
}

export default [{
  method: 'GET',
  path: constants.routes.UPLOAD_LAND_BOUNDARY,
  handler: handlers.get
},
{
  method: 'POST',
  path: constants.routes.UPLOAD_LAND_BOUNDARY,
  handler: handlers.post,
  options: {
    payload: {
      maxBytes: (parseInt(process.env.MAX_GEOSPATIAL_LAND_BOUNDARY_UPLOAD_MB) + 1) * 1024 * 1024,
      multipart: true,
      timeout: false,
      output: 'stream',
      parse: false,
      allow: 'multipart/form-data',
      failAction: (request, h, err) => {
        console.log('File upload too large', request.path)
        if (err.output.statusCode === 413) { // Request entity too large
          return h.view(constants.views.UPLOAD_LAND_BOUNDARY, {
            err: [
              {
                text: 'The selected file must not be larger than 50MB',
                href: LAND_BOUNDARY_ID
              }
            ]
          }).takeover()
        } else {
          throw err
        }
      }
    }
  }
}
]