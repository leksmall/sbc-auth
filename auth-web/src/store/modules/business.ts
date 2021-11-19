import { Action, Module, Mutation, VuexModule } from 'vuex-module-decorators'
import { Business, BusinessRequest, FolioNumberload, LoginPayload, PasscodeResetLoad } from '@/models/business'
import {
  CorpType,
  FilingTypes,
  LearFilingTypes,
  LegalTypes,
  NrConditionalStates,
  NrState,
  SessionStorageKeys
} from '@/util/constants'
import { CreateRequestBody as CreateAffiliationRequestBody, CreateNRAffiliationRequestBody } from '@/models/affiliation'
import { Organization, RemoveBusinessPayload } from '@/models/Organization'
import BusinessService from '@/services/business.services'
import ConfigHelper from '@/util/config-helper'
import { Contact } from '@/models/contact'
import OrgService from '@/services/org.services'

@Module({
  name: 'business',
  namespaced: true
})
export default class BusinessModule extends VuexModule {
  currentBusiness: Business = undefined
  businesses: Business[] = []

  @Mutation
  public setCurrentBusiness (business: Business) {
    ConfigHelper.addToSession(SessionStorageKeys.BusinessIdentifierKey, business?.businessIdentifier)
    this.currentBusiness = business
  }

  @Mutation
  public setBusinesses (businesses: Business[]) {
    this.businesses = businesses
  }

  @Action({ rawError: true })
  public async syncBusinesses (): Promise<void> {
    /** Returns NR's approved name. */
    const getApprovedName = (nr): string =>
      nr.names.find(name => [NrState.APPROVED, NrState.CONDITION].includes(name.state))?.name

    /** Returns True if NR is approved for incorporation. */
    const isApprovedForIa = (nr): boolean =>
      (nr.state === NrState.APPROVED &&
        nr.actions.some(action => action.filingName === LearFilingTypes.INCORPORATION))

    /** Returns True if NR is conditionally approved. */
    const isConditionallyApproved = (nr): boolean =>
      (nr.state === NrState.CONDITIONAL &&
        [NrConditionalStates.RECEIVED, NrConditionalStates.WAIVED].includes(nr.consentFlag))

    /** Returns True if NR is approved for one stop registration. */
    const isApprovedForRegistration = (nr): boolean =>
      nr.actions.some(action => action.filingName === LearFilingTypes.REGISTRATION)

    // get current organization
    const organization = this.context.rootState.org.currentOrganization as Organization
    if (!organization) {
      console.log('Invalid organization') // eslint-disable-line no-console
      return
    }

    // fetch affiliated entities for this organization
    const affiliatedEntities = await OrgService.getAffiliatiatedEntities(organization.id)
      .then(response => {
        if (response?.data?.entities && response?.status === 200) {
          return response.data.entities
        }
        throw new Error(`Invalid response = ${response}`)
      })
      .catch(error => {
        console.log('Error getting affiliated entities:', error) // eslint-disable-line no-console
        return [] as Business[]
      })
    // console.log('*** affiliated entities =', affiliatedEntities) // eslint-disable-line no-console

    // get only NR affiliations
    const nameRequests = affiliatedEntities.map(entity => {
      return (entity.corpType.code === CorpType.NAME_REQUEST) ? entity : null
    })
    // console.log('*** name requests =', nameRequests) // eslint-disable-line no-console

    // get data for all NRs
    const getNrDataPromises = nameRequests.map(nameRequest => {
      return nameRequest ? BusinessService.getNrData(nameRequest.businessIdentifier) : null
    })
    // console.log('*** nr data promises =', getNrDataPromises) // eslint-disable-line no-console

    // wait for all calls to finish
    const getNrDataResponses = await Promise.allSettled(getNrDataPromises)
    // console.log('*** get nr data responses =', getNrDataResponses) // eslint-disable-line no-console

    // attach NR data to NR affiliations
    getNrDataResponses
      .map(response => response['value']?.data || null)
      .map((nr, i) => {
        if (nr) {
          affiliatedEntities[i].nameRequest = {
            names: nr.names,
            id: nr.id,
            legalType: nr.legalType,
            nrNumber: nr.nrNum,
            state: nr.state,
            applicantEmail: nr.applicants?.emailAddress,
            applicantPhone: nr.applicants?.phoneNumber,
            enableIncorporation: isApprovedForIa(nr) || isConditionallyApproved(nr) || isApprovedForRegistration(nr),
            folioNumber: nr.folioNumber,
            target: nr.target
          }
        }
      })

    // update business name for all NRs
    const updateBusinessNamePromises = getNrDataResponses
      .map(response => response['value']?.data || null)
      .map((data, i) => {
        if (data) {
          const businessIdentifier = nameRequests[i].businessIdentifier
          const name = getApprovedName(data)
          return BusinessService.updateBusinessName({ businessIdentifier, name })
        }
        return null
      })
    // console.log('*** update business name promises =', updateBusinessNamePromises) // eslint-disable-line no-console

    // wait for all calls to finish
    const updateBusinessNameResponses = await Promise.allSettled(updateBusinessNamePromises)
    // console.log('*** update business name responses =', getNrDataResponses) // eslint-disable-line no-console

    // update store
    this.setBusinesses(affiliatedEntities)
  }

  @Action({ commit: 'setCurrentBusiness', rawError: true })
  public async loadBusiness () {
    const businessIdentifier = ConfigHelper.getFromSession(SessionStorageKeys.BusinessIdentifierKey)
    const response = await BusinessService.getBusiness(businessIdentifier)
    if (response && response.data && response.status === 200) {
      return response.data
    }
  }

  @Action({ rawError: true })
  public async addBusiness (payload: LoginPayload) {
    const requestBody: CreateAffiliationRequestBody = {
      businessIdentifier: payload.businessIdentifier,
      passCode: payload.passCode
    }

    const currentOrganization: Organization = this.context.rootState.org.currentOrganization

    // Create an affiliation between implicit org and requested business
    return OrgService.createAffiliation(currentOrganization.id, requestBody)
  }

  @Action({ rawError: true })
  public async updateBusinessName (businessNumber: string) {
    try {
      const businessResponse = await BusinessService.searchBusiness(businessNumber)
      if ((businessResponse?.status === 200) && businessResponse?.data?.business?.legalName) {
        const updateBusinessResponse = await BusinessService.updateBusinessName({
          businessIdentifier: businessNumber,
          name: businessResponse.data.business.legalName
        })
        if (updateBusinessResponse?.status === 200) {
          return updateBusinessResponse
        }
      }
      throw Error('update failed')
    } catch (error) {
      // delete the created affiliation if the update failed for avoiding orphan records
      // unable to do these from backend, since it causes a circular dependency
      const orgId = this.context.rootState.org.currentOrganization?.id
      await OrgService.removeAffiliation(orgId, businessNumber, undefined, false)
      return {
        errorMsg: 'Cannot add business due to some technical reasons'
      }
    }
  }

  @Action({ rawError: true })
  public async addNameRequest (requestBody: CreateNRAffiliationRequestBody) {
    const currentOrganization: Organization = this.context.rootState.org.currentOrganization

    // Create an affiliation between implicit org and requested business
    return OrgService.createNRAffiliation(currentOrganization.id, requestBody)
  }

  @Action({ rawError: true })
  public async createNamedBusiness (filingBody: BusinessRequest) {
    // Create an affiliation between implicit org and requested business
    const updateResponse = await BusinessService.createNamedBusiness(filingBody)
    if (updateResponse?.status >= 200 && updateResponse?.status < 300) {
      return updateResponse
    } else {
      // delete the created affiliation if the update failed for avoiding orphan records
      // unable to do these from backend, since it causes a circular dependency
      const orgId = filingBody?.filing?.header?.accountId
      const nrNumber = filingBody?.filing?.incorporationApplication?.nameRequest?.nrNumber
      await OrgService.removeAffiliation(orgId, nrNumber, undefined, false)
      return {
        errorMsg: 'Cannot add business due to some technical reasons'
      }
    }
  }

  // Following searchBusiness will search data from legal-api.
  @Action({ rawError: true })
  public async searchBusiness (businessNumber: string): Promise<any> {
    return BusinessService.searchBusiness(businessNumber)
      .then(response => {
        if (response.status === 200) {
          ConfigHelper.addToSession(SessionStorageKeys.BusinessIdentifierKey, businessNumber)
        }
      })
  }

  @Action({ rawError: true })
  public async createNumberedBusiness (accountId: number) {
    const filingBody: BusinessRequest = {
      filing: {
        header: {
          name: FilingTypes.INCORPORATION_APPLICATION,
          accountId: accountId
        },
        business: {
          legalType: LegalTypes.BCOMP
        },
        incorporationApplication: {
          nameRequest: {
            legalType: LegalTypes.BCOMP
          }
        }
      }
    }

    await BusinessService.createNumberedBusiness(filingBody)
      .then(response => {
        if (response && response.data && (response.status === 200 || response.status === 201)) {
          const tempRegNum = response.data.filing?.business?.identifier
          if (tempRegNum) {
            ConfigHelper.addToSession(SessionStorageKeys.BusinessIdentifierKey, tempRegNum)
            const redirectURL = `${ConfigHelper.getBusinessURL()}${tempRegNum}`

            window.location.href = decodeURIComponent(redirectURL)
          }
        }
      }).catch(error => {
        // eslint-disable-next-line no-console
        console.log(error) // ToDo: Handle error: Redirect back to Homeview? Feedback required here
      })
  }

  @Action({ rawError: true })
  public async removeBusiness (payload: RemoveBusinessPayload) {
    // If the business is a new registration then remove the business filing from legal-db
    if (payload.business.corpType.code === CorpType.NEW_BUSINESS) {
      let filingResponse = await BusinessService.getFilings(payload.business.businessIdentifier)
      if (filingResponse && filingResponse.data && filingResponse.status === 200) {
        let filingId = filingResponse?.data?.filing?.header?.filingId
        // If there is a filing delete it which will delete the affiliation, else delete the affiliation
        if (filingId) {
          await BusinessService.deleteBusinessFiling(payload.business.businessIdentifier, filingId)
        } else {
          await OrgService.removeAffiliation(payload.orgIdentifier, payload.business.businessIdentifier, payload.passcodeResetEmail, payload.resetPasscode)
        }
      }
    } else {
      // Remove an affiliation between the given business and each specified org
      await OrgService.removeAffiliation(payload.orgIdentifier, payload.business.businessIdentifier, payload.passcodeResetEmail, payload.resetPasscode)
    }
  }

  @Action({ commit: 'setCurrentBusiness', rawError: true })
  public async saveContact (contact: Contact) {
    let currentBusiness: Business = this.context.state['currentBusiness']
    let response = null
    if (!currentBusiness.contacts || currentBusiness.contacts.length === 0) {
      response = await BusinessService.addContact(currentBusiness, contact)
    } else {
      response = await BusinessService.updateContact(currentBusiness, contact)
    }
    if (response && response.data && (response.status === 200 || response.status === 201)) {
      return response.data
    }
  }

  @Action({ rawError: true })
  public async updateFolioNumber (folioNumberload: FolioNumberload) {
    await BusinessService.updateFolioNumber(folioNumberload)
  }

  @Action({ rawError: true })
  public async resetCurrentBusiness (): Promise<void> {
    this.context.commit('setCurrentBusiness', undefined)
    ConfigHelper.removeFromSession(SessionStorageKeys.BusinessIdentifierKey)
  }

  @Action({ rawError: true })
  public async resetBusinessPasscode (passCodeResetLoad: PasscodeResetLoad) {
    await BusinessService.resetBusinessPasscode(passCodeResetLoad)
  }
}
