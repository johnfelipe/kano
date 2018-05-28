import path from 'path'
import _ from 'lodash'
import logger from 'winston'
import kCore from 'kCore'
import packageInfo from '../../package.json'

const servicesPath = path.join(__dirname, '..', 'services')
module.exports = async function () {
  const app = this

  // Set up our plugin services
  try {
    app.use(app.get('apiPath') + '/capabilities', (req, res, next) => {
      let response = {
        name: 'kapp',
        domain: app.get('domain'),
        version: packageInfo.version,
        billing: app.get('billing')
      }
      if (process.env.BUILD_NUMBER) {
        response.buildNumber = process.env.BUILD_NUMBER
      }
      res.json(response)
    })
    await app.configure(kCore)
    // Add hook to automatically create a new organisation, add verification, send verification email,
    // register devices, etc. when creating a new user or authenticating
    app.configureService('users', app.getService('users'), servicesPath)
    app.configureService('authentication', app.getService('authentication'), servicesPath)
  } catch (error) {
    logger.error(error.message)
  }

  let usersService = app.getService('users')
  let defaultUsers = app.get('authentication').defaultUsers
  // Do not use exposed passwords on staging/prod environments
  if (defaultUsers && !process.env.NODE_APP_INSTANCE) {
    // Create default users if not already done
    const users = await usersService.find({ paginate: false })
    for (let i = 0; i < defaultUsers.length; i++) {
      const defaultUser = defaultUsers[i]
      let createdUser = _.find(users, user => user.email === defaultUser.email)
      if (!createdUser) {
        logger.info('Initializing default user (email = ' + defaultUser.email + ', password = ' + defaultUser.password + ')')
        await usersService.create(defaultUser)
      }
    }
  }
}
